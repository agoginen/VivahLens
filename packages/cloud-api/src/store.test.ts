import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryCloudStore } from "./memoryStore.js";
import { CLOUD_SCHEMA_VERSION, SqliteCloudStore } from "./sqliteStore.js";
import type { Activation, CloudStore, Subscription } from "./store.js";

const dir = mkdtempSync(path.join(tmpdir(), "vivah-cloud-store-"));
const opened: SqliteCloudStore[] = [];
afterAll(() => {
  // Windows cannot delete a database file that is still open.
  for (const s of opened) s.close();
  rmSync(dir, { recursive: true, force: true });
});

const sub = (over: Partial<Subscription> = {}): Subscription => ({ accountId: "acct1", plan: "pro", seats: 2, adapters: ["xmp-sidecar", "rawtherapee"], status: "active", currentPeriodEnd: 123, updatedAt: 1, ...over });
const act = (over: Partial<Activation> = {}): Activation => ({ id: "act1", licenseId: "lic1", deviceId: "dev-1", deviceName: "Studio PC", refreshTokenHash: "h1", createdAt: 10, lastSeenAt: 10, revokedAt: null, ...over });

describe.each<[string, () => CloudStore]>([
  ["MemoryCloudStore", () => new MemoryCloudStore()],
  [
    "SqliteCloudStore",
    () => {
      const s = new SqliteCloudStore(path.join(dir, `${Math.random().toString(36).slice(2)}.db`));
      opened.push(s);
      return s;
    },
  ],
])("%s contract", (_name, make) => {
  it("stores accounts with unique emails and subscriptions that can be replaced", () => {
    const s = make();
    s.createAccount({ id: "acct1", email: "a@example.com", createdAt: 1 });
    expect(s.getAccountByEmail("a@example.com")).toEqual({ id: "acct1", email: "a@example.com", createdAt: 1 });
    expect(() => s.createAccount({ id: "acct2", email: "a@example.com", createdAt: 2 })).toThrow();
    expect(s.getAccount("nope")).toBeUndefined();

    s.upsertSubscription(sub());
    expect(s.getSubscription("acct1")).toEqual(sub());
    s.upsertSubscription(sub({ status: "canceled", currentPeriodEnd: null, adapters: ["xmp-sidecar"] }));
    expect(s.getSubscription("acct1")).toMatchObject({ status: "canceled", currentPeriodEnd: null, adapters: ["xmp-sidecar"] });
  });

  it("finds licenses by key hash only, and revokes them once", () => {
    const s = make();
    s.createLicense({ id: "lic1", accountId: "acct1", keyHash: "hash-1", maxDevices: 2, createdAt: 1, revokedAt: null });
    expect(() => s.createLicense({ id: "lic2", accountId: "acct1", keyHash: "hash-1", maxDevices: 2, createdAt: 1, revokedAt: null })).toThrow();
    expect(s.getLicenseByKeyHash("hash-1")!.id).toBe("lic1");
    expect(s.getLicenseByKeyHash("nope")).toBeUndefined();
    s.revokeLicense("lic1", 50);
    s.revokeLicense("lic1", 99);
    expect(s.getLicense("lic1")!.revokedAt).toBe(50);
    expect(s.listLicenses("acct1")).toHaveLength(1);
  });

  it("re-activating the same device keeps its id, replaces the token and clears revocation", () => {
    const s = make();
    const first = s.upsertActivation(act());
    s.revokeActivation("act1", 20);
    expect(s.getActivation("act1")!.revokedAt).toBe(20);

    const again = s.upsertActivation(act({ id: "act-ignored", deviceName: "Renamed", refreshTokenHash: "h2", lastSeenAt: 30 }));
    expect(again).toMatchObject({ id: first.id, deviceName: "Renamed", refreshTokenHash: "h2", revokedAt: null, createdAt: 10 });
    expect(s.getActivationByRefreshHash("h1")).toBeUndefined();
    expect(s.getActivationByRefreshHash("h2")!.id).toBe("act1");

    s.upsertActivation(act({ id: "act2", deviceId: "dev-2", refreshTokenHash: "h3" }));
    expect(s.listActivations("lic1").map((a) => a.deviceId)).toEqual(["dev-1", "dev-2"]);
    s.touchActivation("act2", 77);
    expect(s.getActivation("act2")!.lastSeenAt).toBe(77);
  });

  it("counts usage events once per (activation, event id)", () => {
    const s = make();
    const e = { activationId: "act1", eventId: "e1", at: 1, photos: 5, llmCalls: 5, inputTokens: 100, outputTokens: 50, costUsd: 0.01 };
    expect(s.recordUsage([e, { ...e, eventId: "e2" }])).toEqual({ accepted: 2, duplicates: 0 });
    expect(s.recordUsage([e, { ...e, eventId: "e3" }, { ...e, activationId: "act2" }])).toEqual({ accepted: 2, duplicates: 1 });
  });

  it("enforces optimistic concurrency on style profiles and scopes them per account", () => {
    const s = make();
    const put = (accountId: string, expected: number | null, blob = "QQ==") => s.putStyleProfile({ accountId, profileId: "warm", name: "Warm", blob, now: 5 }, expected);
    expect(put("acct1", 1)).toBeUndefined();
    expect(put("acct1", null)!.version).toBe(1);
    expect(put("acct1", null)).toBeUndefined();
    expect(put("acct1", 1, "Qg==")!.version).toBe(2);
    expect(put("acct1", 1)).toBeUndefined();
    expect(s.getStyleProfile("acct1", "warm")).toMatchObject({ version: 2, blob: "Qg==" });
    expect(s.getStyleProfile("acct2", "warm")).toBeUndefined();
    expect(put("acct2", null)!.version).toBe(1);
    expect(s.listStyleProfiles("acct1")).toEqual([{ accountId: "acct1", profileId: "warm", name: "Warm", version: 2, updatedAt: 5 }]);
    expect("blob" in s.listStyleProfiles("acct1")[0]!).toBe(false);
  });

  it("remembers webhook event ids", () => {
    const s = make();
    expect(s.recordWebhookEvent("evt-1", 1)).toBe(true);
    expect(s.recordWebhookEvent("evt-1", 2)).toBe(false);
    expect(s.recordWebhookEvent("evt-2", 2)).toBe(true);
  });

  it("holds a published document byte for byte, replaces it by name, and does not alias what it returned", () => {
    const s = make();
    expect(s.getDocument("updates-stable")).toBeUndefined();
    const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
    s.putDocument({ name: "updates-stable", bytes, signature: '{"kid":"k1"}', updatedAt: 5 });
    const got = s.getDocument("updates-stable")!;
    expect(got).toEqual({ name: "updates-stable", bytes, signature: '{"kid":"k1"}', updatedAt: 5 });
    got.bytes[0] = 99;
    bytes[1] = 99;
    expect(s.getDocument("updates-stable")!.bytes.equals(Buffer.from([0, 1, 2, 255, 254, 10, 13]))).toBe(true);

    s.putDocument({ name: "updates-stable", bytes: Buffer.from("v2"), signature: '{"kid":"k2"}', updatedAt: 9 });
    expect(s.getDocument("updates-stable")).toMatchObject({ signature: '{"kid":"k2"}', updatedAt: 9 });
    expect(s.getDocument("updates-stable")!.bytes.toString()).toBe("v2");
    expect(s.getDocument("config")).toBeUndefined();
  });
});

describe("SqliteCloudStore migrations", () => {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

  it("creates the schema on a new database and is idempotent when reopened", () => {
    const file = path.join(dir, "fresh.db");
    const a = new SqliteCloudStore(file);
    expect(a.schemaVersion()).toBe(CLOUD_SCHEMA_VERSION);
    a.createAccount({ id: "x", email: "x@example.com", createdAt: 1 });
    a.close();
    const b = new SqliteCloudStore(file);
    opened.push(b);
    expect(b.getAccount("x")).toBeDefined();
  });

  it("upgrades a version-0 (empty) database", () => {
    const file = path.join(dir, "legacy.db");
    const raw = new DatabaseSync(file);
    expect((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0);
    raw.close();
    const s = new SqliteCloudStore(file);
    opened.push(s);
    expect(s.schemaVersion()).toBe(CLOUD_SCHEMA_VERSION);
  });

  it("refuses a newer database and does not leave it locked", () => {
    const file = path.join(dir, "future.db");
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${CLOUD_SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => new SqliteCloudStore(file)).toThrow(/newer than this server supports/);
    // The failed constructor closed its connection, so the file can be removed immediately (Windows would refuse otherwise).
    expect(() => rmSync(file)).not.toThrow();
  });
});
