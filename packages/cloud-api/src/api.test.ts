import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawPublicKey, signDocument, verifyEntitlement, verifyManifest, CONFIG_DOMAIN, MANIFEST_DOMAIN } from "@vivahlens/core";
import { createCloudApi } from "./api.js";
import { MemoryCloudStore } from "./memoryStore.js";
import { DAY_MS, PAST_DUE_GRACE_MS, TOKEN_TTL_MS } from "./plans.js";
import { SqliteCloudStore } from "./sqliteStore.js";
import type { CloudStore } from "./store.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const SIGNING_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const ADMIN = "admin-key-for-tests-0123456789";
const WEBHOOK_SECRET = "whsec_test_secret_0123456789";
const START = Date.UTC(2026, 10, 22, 12);

let clock = START;
let counter = 0;
const deterministicBytes = (n: number) => {
  let out = Buffer.alloc(0);
  while (out.length < n) out = Buffer.concat([out, createHash("sha256").update(`seed-${counter++}`).digest()]);
  return out.subarray(0, n);
};

interface Harness {
  call(method: string, path: string, opts?: { body?: unknown; raw?: string; headers?: Record<string, string>; token?: string; admin?: boolean | string }): Promise<{ status: number; json: any; headers: Headers }>;
  webhook(body: unknown, over?: { signature?: string; headers?: Record<string, string> }): Promise<{ status: number; json: any }>;
  /** A GET whose body is returned as bytes, for documents that are not JSON. */
  fetchRaw(path: string, headers?: Record<string, string>): Promise<{ status: number; body: Buffer; headers: Headers }>;
  customer(over?: { plan?: string; status?: string; email?: string; maxDevices?: number; periodEnd?: string | null }): Promise<{ accountId: string; licenseId: string; licenseKey: string }>;
  activate(licenseKey: string, deviceId?: string, deviceName?: string): Promise<{ status: number; json: any }>;
  logs: { level: string; msg: string; [k: string]: unknown }[];
  store: CloudStore;
}

let closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  clock = START;
  counter = 0;
});
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
});

async function start(opts: { store?: CloudStore; trustProxy?: boolean } = {}): Promise<Harness> {
  const store = opts.store ?? new MemoryCloudStore();
  const logs: Harness["logs"] = [];
  const api = createCloudApi({ store, signingKeyPem: SIGNING_PEM, adminKey: ADMIN, webhookSecret: WEBHOOK_SECRET, now: () => clock, randomBytes: deterministicBytes, trustProxy: opts.trustProxy, logger: (e) => void logs.push(e) });
  const server = await api.listen(0);
  closers.push(server.close);
  const base = `http://127.0.0.1:${server.port}`;

  const call: Harness["call"] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { ...(o.body !== undefined || o.raw !== undefined ? { "content-type": "application/json" } : {}), ...o.headers };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.admin) headers.authorization = `Bearer ${o.admin === true ? ADMIN : o.admin}`;
    const res = await fetch(`${base}${path}`, { method, headers, body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
  };
  const sign = (raw: string) => createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  const fetchRaw: Harness["fetchRaw"] = async (route, headers = {}) => {
    const res = await fetch(`${base}${route}`, { headers });
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  };
  const webhook: Harness["webhook"] = async (body, over = {}) => {
    const raw = JSON.stringify(body);
    const r = await call("POST", "/webhooks/billing", { raw, headers: { "x-signature": over.signature ?? sign(raw), ...over.headers } });
    return { status: r.status, json: r.json };
  };
  let n = 0;
  const customer: Harness["customer"] = async (o = {}) => {
    const email = o.email ?? `customer${n++}@example.com`;
    const account = await call("POST", "/admin/v1/accounts", { body: { email }, admin: true });
    const accountId = account.json.accountId as string;
    const periodEnd = o.periodEnd === undefined ? new Date(START + 30 * DAY_MS).toISOString() : o.periodEnd;
    await call("PUT", `/admin/v1/accounts/${accountId}/subscription`, { body: { plan: o.plan ?? "pro", seats: 2, status: o.status ?? "active", currentPeriodEnd: periodEnd }, admin: true });
    const lic = await call("POST", "/admin/v1/licenses", { body: { accountId, ...(o.maxDevices ? { maxDevices: o.maxDevices } : {}) }, admin: true });
    return { accountId, licenseId: lic.json.licenseId, licenseKey: lic.json.licenseKey };
  };
  const activate: Harness["activate"] = async (licenseKey, deviceId = "device-aaaa-1111", deviceName = "Studio PC") => {
    const r = await call("POST", "/v1/activate", { body: { licenseKey, deviceId, deviceName } });
    return { status: r.status, json: r.json };
  };
  return { call, webhook, fetchRaw, customer, activate, logs, store };
}

describe("activation, refresh and deactivation", () => {
  it("issues a signed entitlement that verifies offline and degrades with time", async () => {
    const h = await start();
    const c = await h.customer();
    const res = await h.activate(c.licenseKey);
    expect(res.status).toBe(200);
    expect(res.json.expiresAt).toBe(START + TOKEN_TTL_MS);

    const { entitlement, status } = verifyEntitlement(res.json.entitlementToken, publicKey, START + DAY_MS);
    expect(entitlement).toMatchObject({ accountId: c.accountId, plan: "pro", seats: 2, adapters: ["xmp-sidecar", "rawtherapee", "darktable", "lightroom-classic", "builtin-render", "video-timeline"], issuedAt: START });
    expect(entitlement.limits).toBeUndefined();
    expect(status).toBe("active");
    expect(verifyEntitlement(res.json.entitlementToken, publicKey, START + 8 * DAY_MS).status).toBe("grace");
    expect(verifyEntitlement(res.json.entitlementToken, publicKey, START + 22 * DAY_MS).status).toBe("expired");
  });

  it("gives a trial the guided-batch cap in its signed token, on activation and on every refresh, and a paid plan none", async () => {
    const h = await start();
    const trial = await h.customer({ plan: "trial", status: "trialing" });
    const act = await h.activate(trial.licenseKey);
    expect(verifyEntitlement(act.json.entitlementToken, publicKey, START).entitlement).toMatchObject({ plan: "trial", adapters: ["xmp-sidecar", "builtin-render"], limits: { maxPhotosPerJob: 50 } });
    const refreshed = await h.call("POST", "/v1/refresh", { token: act.json.refreshToken });
    expect(verifyEntitlement(refreshed.json.entitlementToken, publicKey, START).entitlement.limits).toEqual({ maxPhotosPerJob: 50 });

    for (const plan of ["starter", "pro", "studio"]) {
      const paid = await h.customer({ plan });
      const token = (await h.activate(paid.licenseKey, `device-${plan}-0001`)).json.entitlementToken;
      expect(verifyEntitlement(token, publicKey, START).entitlement.limits).toBeUndefined();
    }
  });

  it("runs the whole lifecycle: activate, refresh, deactivate, then the token stops working", async () => {
    const h = await start();
    const c = await h.customer();
    const { json: act } = await h.activate(c.licenseKey);

    clock += 3 * DAY_MS;
    const refreshed = await h.call("POST", "/v1/refresh", { token: act.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.expiresAt).toBe(clock + TOKEN_TTL_MS);
    expect(verifyEntitlement(refreshed.json.entitlementToken, publicKey, clock).status).toBe("active");

    expect((await h.call("POST", "/v1/deactivate", { token: act.refreshToken })).status).toBe(204);
    const after = await h.call("POST", "/v1/refresh", { token: act.refreshToken });
    expect(after.status).toBe(401);
    expect(after.json.code).toBe("INVALID_TOKEN");
  });

  it("enforces the device cap, replaces the token when the same device re-activates, and frees a slot on deactivate", async () => {
    const h = await start();
    const c = await h.customer({ maxDevices: 2 });
    const d1 = (await h.activate(c.licenseKey, "device-aaaa-0001", "Laptop")).json;
    const d2 = (await h.activate(c.licenseKey, "device-aaaa-0002", "Desktop")).json;
    const third = await h.activate(c.licenseKey, "device-aaaa-0003", "Tablet");
    expect(third.status).toBe(409);
    expect(third.json.code).toBe("DEVICE_LIMIT_REACHED");

    const again = (await h.activate(c.licenseKey, "device-aaaa-0001", "Laptop (new)")).json;
    expect(again.activationId).toBe(d1.activationId);
    expect((await h.call("POST", "/v1/refresh", { token: d1.refreshToken })).status).toBe(401);
    expect((await h.call("POST", "/v1/refresh", { token: again.refreshToken })).status).toBe(200);

    await h.call("POST", "/v1/deactivate", { token: d2.refreshToken });
    expect((await h.activate(c.licenseKey, "device-aaaa-0003", "Tablet")).status).toBe(200);
  });

  it("does not reveal why a license key was rejected", async () => {
    const h = await start();
    const c = await h.customer();
    for (const key of ["VL-AAAAA-AAAAA-AAAAA-AAAAA", "nonsense", c.licenseKey.slice(0, -1)]) {
      const r = await h.activate(key);
      expect(r.status).toBe(401);
      expect(r.json).toEqual({
        type: "urn:vivahlens:problem:invalid-license",
        title: "Unauthorized",
        status: 401,
        detail: "The license key is not valid.",
        code: "INVALID_LICENSE",
        requestId: expect.stringMatching(/^req_/),
      });
    }
  });

  it("cuts off devices when an activation or the whole license is revoked", async () => {
    const h = await start();
    const c = await h.customer();
    const a = (await h.activate(c.licenseKey, "device-aaaa-0001")).json;
    const b = (await h.activate(c.licenseKey, "device-aaaa-0002")).json;

    expect((await h.call("POST", `/admin/v1/activations/${a.activationId}/revoke`, { admin: true })).status).toBe(204);
    expect((await h.call("POST", "/v1/refresh", { token: a.refreshToken })).status).toBe(401);
    expect((await h.call("POST", "/v1/refresh", { token: b.refreshToken })).status).toBe(200);

    expect((await h.call("POST", `/admin/v1/licenses/${c.licenseId}/revoke`, { admin: true })).status).toBe(204);
    expect((await h.call("POST", "/v1/refresh", { token: b.refreshToken })).status).toBe(401);
    expect((await h.activate(c.licenseKey, "device-aaaa-0009")).status).toBe(401);
  });
});

describe("subscription lifecycle", () => {
  it("follows past_due grace, paid-through cancellation and resumption by webhook", async () => {
    const h = await start();
    const c = await h.customer();
    const { json: act } = await h.activate(c.licenseKey);
    const sub = (status: string, periodEnd: number | null) =>
      h.call("PUT", `/admin/v1/accounts/${c.accountId}/subscription`, { body: { plan: "pro", seats: 2, status, currentPeriodEnd: periodEnd === null ? null : new Date(periodEnd).toISOString() }, admin: true });
    const refresh = () => h.call("POST", "/v1/refresh", { token: act.refreshToken });

    await sub("past_due", START);
    clock = START + PAST_DUE_GRACE_MS;
    const grace = await refresh();
    expect(grace.status).toBe(200);
    // The token lapses exactly when the grace period does, not a week later.
    expect(grace.json.expiresAt).toBe(START + PAST_DUE_GRACE_MS);
    clock = START + PAST_DUE_GRACE_MS + 1;
    expect(await refresh().then((r) => [r.status, r.json.code])).toEqual([402, "SUBSCRIPTION_INACTIVE"]);

    clock = START;
    await sub("canceled", START + 5 * DAY_MS);
    clock = START + 5 * DAY_MS;
    expect((await refresh()).status).toBe(200);
    clock = START + 5 * DAY_MS + 1;
    expect((await refresh()).status).toBe(402);

    // The billing provider reports the customer resubscribed.
    await sub("active", START + 35 * DAY_MS);
    expect((await refresh()).status).toBe(200);
  });

  it("refuses to activate without a usable subscription", async () => {
    const h = await start();
    const c = await h.customer({ status: "canceled", periodEnd: new Date(START - DAY_MS).toISOString() });
    expect(await h.activate(c.licenseKey).then((r) => [r.status, r.json.code])).toEqual([402, "SUBSCRIPTION_INACTIVE"]);
  });
});

describe("billing webhook", () => {
  const event = (id: string, data: Record<string, unknown>) => ({ id, type: "subscription.upsert", data: { plan: "studio", seats: 5, status: "active", currentPeriodEnd: new Date(START + 30 * DAY_MS).toISOString(), ...data } });

  it("creates an account from an unknown email, applies the plan, and is idempotent by event id", async () => {
    const h = await start();
    const first = await h.webhook(event("evt_1", { email: "New.Customer@Example.com" }));
    expect(first.status).toBe(200);
    const accountId = first.json.accountId as string;
    expect(h.store.getAccountByEmail("new.customer@example.com")!.id).toBe(accountId);
    expect(h.store.getSubscription(accountId)).toMatchObject({ plan: "studio", seats: 5, status: "active", adapters: ["xmp-sidecar", "rawtherapee", "darktable", "lightroom-classic", "builtin-render", "video-timeline"] });

    const replay = await h.webhook(event("evt_1", { email: "new.customer@example.com", plan: "starter" }));
    expect(replay.json).toEqual({ duplicate: true });
    expect(h.store.getSubscription(accountId)!.plan).toBe("studio");

    const upgrade = await h.webhook(event("evt_2", { accountId, plan: "starter", seats: 1, adapters: ["rawtherapee"] }));
    expect(upgrade.status).toBe(200);
    expect(h.store.getSubscription(accountId)).toMatchObject({ plan: "starter", seats: 1, adapters: ["rawtherapee"] });
  });

  it("rejects missing, wrong and tampered signatures, and accepts the sha256= prefix form", async () => {
    const h = await start();
    const body = event("evt_sig", { email: "sig@example.com" });
    expect((await h.webhook(body, { signature: "" })).status).toBe(401);
    expect((await h.webhook(body, { signature: "0".repeat(64) })).status).toBe(401);
    expect(await h.webhook(body, { signature: "bad" }).then((r) => r.json.code)).toBe("INVALID_SIGNATURE");
    expect(h.store.getAccountByEmail("sig@example.com")).toBeUndefined();

    const raw = JSON.stringify(body);
    const sig = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    expect((await h.webhook(body, { signature: `sha256=${sig.toUpperCase()}` })).status).toBe(200);
    // A valid signature for a different body does not authorise this one.
    const other = createHmac("sha256", WEBHOOK_SECRET).update(JSON.stringify(event("x", { email: "o@example.com" }))).digest("hex");
    expect((await h.webhook(event("evt_other", { email: "t@example.com" }), { signature: other })).status).toBe(401);
  });

  it("ignores unknown event types and does not swallow a malformed event that is later corrected", async () => {
    const h = await start();
    expect(await h.webhook({ id: "evt_x", type: "invoice.paid", data: {} })).toEqual({ status: 200, json: { ignored: true } });

    const bad = await h.webhook(event("evt_fix", { email: "fix@example.com", seats: 0 }));
    expect(bad.status).toBe(400);
    expect(await h.webhook(event("evt_fix", { accountId: "acct_unknown" })).then((r) => r.status)).toBe(400);
    expect(await h.webhook(event("evt_fix", {})).then((r) => r.status)).toBe(400);
    const fixed = await h.webhook(event("evt_fix", { email: "fix@example.com", seats: 3 }));
    expect(fixed.status).toBe(200);
    expect(h.store.getSubscription(fixed.json.accountId)!.seats).toBe(3);
  });

  it("drives activation end to end: a customer paid, so their license works and lapses with the subscription", async () => {
    const h = await start();
    const { json } = await h.webhook(event("evt_a", { email: "paid@example.com", plan: "pro" }));
    const lic = await h.call("POST", "/admin/v1/licenses", { body: { accountId: json.accountId }, admin: true });
    expect((await h.activate(lic.json.licenseKey)).status).toBe(200);
    await h.webhook(event("evt_b", { accountId: json.accountId, status: "canceled", currentPeriodEnd: new Date(START - DAY_MS).toISOString() }));
    expect((await h.activate(lic.json.licenseKey, "device-bbbb-2222")).status).toBe(402);
  });
});

describe("admin API", () => {
  it("rejects missing or wrong admin credentials on every route and hides nothing sensitive in summaries", async () => {
    const h = await start();
    const c = await h.customer();
    await h.activate(c.licenseKey);
    const routes: [string, string, unknown?][] = [
      ["POST", "/admin/v1/accounts", { email: "x@example.com" }],
      ["POST", "/admin/v1/licenses", { accountId: c.accountId }],
      ["GET", `/admin/v1/accounts/${c.accountId}`],
      ["PUT", `/admin/v1/accounts/${c.accountId}/subscription`, { plan: "pro", seats: 1, status: "active" }],
      ["POST", "/admin/v1/activations/act_x/revoke"],
      ["POST", `/admin/v1/licenses/${c.licenseId}/revoke`],
    ];
    for (const [method, path, body] of routes) {
      expect((await h.call(method, path, { body })).status, `${method} ${path} without key`).toBe(401);
      expect((await h.call(method, path, { body, admin: "wrong-key" })).status, `${method} ${path} with wrong key`).toBe(401);
    }

    const summary = await h.call("GET", `/admin/v1/accounts/${c.accountId}`, { admin: true });
    expect(summary.json.licenses[0].activations).toHaveLength(1);
    const text = JSON.stringify(summary.json);
    expect(text).not.toMatch(/keyHash|refreshTokenHash|key_hash/);
    expect(text).not.toContain(c.licenseKey);
  });

  it("rejects duplicate emails, unknown accounts and bad input", async () => {
    const h = await start();
    await h.call("POST", "/admin/v1/accounts", { body: { email: "dup@example.com" }, admin: true });
    expect((await h.call("POST", "/admin/v1/accounts", { body: { email: "DUP@example.com" }, admin: true })).status).toBe(409);
    expect((await h.call("POST", "/admin/v1/accounts", { body: { email: "not-an-email" }, admin: true })).status).toBe(400);
    expect((await h.call("POST", "/admin/v1/accounts", { body: { email: "a@example.com", extra: 1 }, admin: true })).status).toBe(400);
    expect((await h.call("POST", "/admin/v1/licenses", { body: { accountId: "acct_nope" }, admin: true })).status).toBe(404);
    expect((await h.call("GET", "/admin/v1/accounts/acct_nope", { admin: true })).status).toBe(404);
    expect((await h.call("POST", "/admin/v1/activations/act_nope/revoke", { admin: true })).status).toBe(404);
  });
});

describe("usage metering", () => {
  const ev = (over: Record<string, unknown> = {}) => ({ eventId: "e1", at: new Date(START).toISOString(), photos: 120, llmCalls: 118, inputTokens: 190000, outputTokens: 47000, costUsd: 0.42, ...over });

  async function authed() {
    const h = await start();
    const c = await h.customer();
    return { h, token: (await h.activate(c.licenseKey)).json.refreshToken as string };
  }

  it("accepts counts and is idempotent per event id", async () => {
    const { h, token } = await authed();
    expect((await h.call("POST", "/v1/usage", { token, body: { events: [ev(), ev({ eventId: "e2" })] } })).json).toEqual({ accepted: 2, duplicates: 0 });
    expect((await h.call("POST", "/v1/usage", { token, body: { events: [ev(), ev({ eventId: "e3" })] } })).json).toEqual({ accepted: 1, duplicates: 1 });
  });

  it("rejects anything that could carry content or abuse the table", async () => {
    const { h, token } = await authed();
    const bad: [string, unknown][] = [
      ["unknown keys (no free text)", { events: [ev({ filename: "IMG_0001.CR3" })] }],
      ["negative number", { events: [ev({ photos: -1 })] }],
      ["fractional photos", { events: [ev({ photos: 1.5 })] }],
      ["string instead of number", { events: [ev({ costUsd: "free" })] }],
      ["absurd tokens", { events: [ev({ inputTokens: 1e12 })] }],
      ["empty batch", { events: [] }],
      ["too many events", { events: Array.from({ length: 501 }, (_, i) => ev({ eventId: `e${i}` })) }],
      ["stale timestamp", { events: [ev({ at: new Date(START - 3 * DAY_MS).toISOString() })] }],
      ["future timestamp", { events: [ev({ at: new Date(START + 3 * DAY_MS).toISOString() })] }],
      ["top-level extras", { events: [ev()], note: "hi" }],
    ];
    for (const [name, body] of bad) expect((await h.call("POST", "/v1/usage", { token, body })).status, name).toBe(400);
    expect((await h.call("POST", "/v1/usage", { body: { events: [ev()] } })).status).toBe(401);
  });

  it("turns away a batch that is too long by its length alone, however many broken events it holds", async () => {
    const { h, token } = await authed();
    // Close to the largest body the server takes, and every event in it would fail several checks.
    const r = await h.call("POST", "/v1/usage", { token, body: { events: Array.from({ length: 80_000 }, () => ({})) } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toContain("events: Expected an array of at most 500 items");
  });
});

describe("style profile sync", () => {
  const blob = Buffer.from("encrypted-style-bytes").toString("base64");
  async function two() {
    const h = await start();
    const a = await h.customer();
    const b = await h.customer();
    return { h, a: (await h.activate(a.licenseKey)).json.refreshToken as string, b: (await h.activate(b.licenseKey, "device-bbbb-9999")).json.refreshToken as string };
  }

  it("creates, reads, updates with If-Match, and detects conflicts", async () => {
    const { h, a } = await two();
    const put = (headers: Record<string, string>, body: unknown = { name: "Warm", blob }) => h.call("PUT", "/v1/style-profiles/warm-wedding", { token: a, body, headers });

    expect((await put({})).status).toBe(428);
    expect((await put({ "if-match": '"v1"' })).status).toBe(412);
    const created = await put({ "if-none-match": "*" });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ profileId: "warm-wedding", version: 1, etag: '"v1"' });
    expect(created.headers.get("etag")).toBe('"v1"');

    const read = await h.call("GET", "/v1/style-profiles/warm-wedding", { token: a });
    expect(read.json).toMatchObject({ name: "Warm", blob, version: 1, etag: '"v1"' });

    expect((await put({})).status).toBe(428);
    const updated = await put({ "if-match": '"v1"' }, { name: "Warmer", blob: Buffer.from("v2").toString("base64") });
    expect(updated.status).toBe(200);
    expect(updated.json.version).toBe(2);
    expect((await put({ "if-match": '"v1"' })).status).toBe(412);
    expect((await put({ "if-none-match": "*" })).status).toBe(412);

    const list = await h.call("GET", "/v1/style-profiles", { token: a });
    expect(list.json).toEqual({ profiles: [{ profileId: "warm-wedding", name: "Warmer", version: 2, etag: '"v2"', updatedAt: START }] });
  });

  it("keeps each account's profiles private and validates ids and payloads", async () => {
    const { h, a, b } = await two();
    await h.call("PUT", "/v1/style-profiles/mine", { token: a, body: { name: "Mine", blob }, headers: { "if-none-match": "*" } });
    expect((await h.call("GET", "/v1/style-profiles/mine", { token: b })).status).toBe(404);
    expect((await h.call("GET", "/v1/style-profiles", { token: b })).json).toEqual({ profiles: [] });
    expect((await h.call("PUT", "/v1/style-profiles/mine", { token: b, body: { name: "Hijack", blob }, headers: { "if-none-match": "*" } })).status).toBe(201);
    expect((await h.call("GET", "/v1/style-profiles/mine", { token: a })).json.name).toBe("Mine");

    const put = (id: string, body: unknown) => h.call("PUT", `/v1/style-profiles/${id}`, { token: a, body, headers: { "if-none-match": "*" } });
    expect((await put("Bad_ID", { name: "x", blob })).status).toBe(400);
    expect((await put("..%2F..%2Fetc", { name: "x", blob })).status).toBe(400);
    expect((await put("ok", { name: "x", blob: "not base64!!" })).status).toBe(400);
    expect((await put("ok", { name: "x", blob, extra: true })).status).toBe(400);
    expect((await put("ok", { name: "", blob })).status).toBe(400);
    expect((await h.call("GET", "/v1/style-profiles/mine")).status).toBe(401);
  });

  it("requires an active subscription", async () => {
    const h = await start();
    const c = await h.customer();
    const token = (await h.activate(c.licenseKey)).json.refreshToken as string;
    await h.call("PUT", `/admin/v1/accounts/${c.accountId}/subscription`, { admin: true, body: { plan: "pro", seats: 1, status: "canceled", currentPeriodEnd: new Date(START - DAY_MS).toISOString() } });
    expect((await h.call("GET", "/v1/style-profiles", { token })).status).toBe(402);
  });
});

describe("request hygiene", () => {
  it("enforces JSON content types, valid JSON and a body size cap", async () => {
    const h = await start();
    const c = await h.customer();
    const post = (o: Parameters<Harness["call"]>[2]) => h.call("POST", "/v1/activate", o);
    expect((await post({ raw: JSON.stringify({ licenseKey: c.licenseKey, deviceId: "device-aaaa-1111", deviceName: "x" }), headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await post({ raw: "{nope" })).status).toBe(400);
    expect((await post({ body: { licenseKey: c.licenseKey, deviceId: "device-aaaa-1111", deviceName: "x", extra: 1 } })).status).toBe(400);
    expect((await post({ body: { licenseKey: c.licenseKey, deviceId: "short", deviceName: "x" } })).status).toBe(400);
    const big = await post({ raw: JSON.stringify({ licenseKey: c.licenseKey, deviceId: "device-aaaa-1111", deviceName: "x".repeat(300_000) }) });
    expect(big.status).toBe(413);
    expect(big.json.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("answers health checks and unknown routes without leaking internals", async () => {
    const h = await start();
    expect((await h.call("GET", "/healthz")).json).toEqual({ ok: true });
    for (const [m, p] of [["GET", "/"], ["GET", "/v1/nope"], ["DELETE", "/v1/refresh"], ["GET", "/admin/v1/nothing"]] as const) {
      const r = await h.call(m, p, { admin: p.startsWith("/admin") });
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.json.code).toBe("NOT_FOUND");
    }
    expect((await h.call("GET", "/healthz")).headers.get("cache-control")).toBe("no-store");
  });
});

describe("abuse protection", () => {
  it("limits activation attempts per client and says when to retry", async () => {
    const h = await start();
    const c = await h.customer();
    for (let i = 0; i < 10; i++) expect((await h.activate(c.licenseKey, "device-aaaa-1111")).status).toBe(200);
    const limited = await h.call("POST", "/v1/activate", { body: { licenseKey: c.licenseKey, deviceId: "device-aaaa-1111", deviceName: "x" } });
    expect(limited.status).toBe(429);
    expect(limited.json.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    clock += 61_000;
    expect((await h.activate(c.licenseKey, "device-aaaa-1111")).status).toBe(200);
  });

  it("locks out key guessing after five failures, even for the real key, until the window passes", async () => {
    const h = await start();
    const c = await h.customer();
    for (let i = 0; i < 5; i++) expect((await h.activate("VL-AAAAA-AAAAA-AAAAA-AAAA" + i)).status).toBe(401);
    expect((await h.activate(c.licenseKey)).status).toBe(429);
    clock += 61_000;
    expect((await h.activate(c.licenseKey)).status).toBe(200);
  });

  it("limits refresh bursts per token, and tracks clients separately behind a trusted proxy", async () => {
    const h = await start();
    const c = await h.customer();
    const token = (await h.activate(c.licenseKey)).json.refreshToken as string;
    for (let i = 0; i < 60; i++) expect((await h.call("POST", "/v1/refresh", { token })).status).toBe(200);
    expect((await h.call("POST", "/v1/refresh", { token })).status).toBe(429);

    const proxied = await start({ trustProxy: true });
    const pc = await proxied.customer();
    const post = (ip: string) => proxied.call("POST", "/v1/activate", { body: { licenseKey: pc.licenseKey, deviceId: "device-aaaa-1111", deviceName: "x" }, headers: { "x-forwarded-for": ip } });
    for (let i = 0; i < 10; i++) await post("203.0.113.1");
    expect((await post("203.0.113.1")).status).toBe(429);
    expect((await post("203.0.113.2")).status).toBe(200);
  });
});

describe("signed documents", () => {
  const signer = generateKeyPairSync("ed25519");
  const trusted = { k1: rawPublicKey(signer.privateKey) };
  const manifestBytes = Buffer.from(
    JSON.stringify({
      schema: 1,
      channel: "stable",
      sequence: 7,
      issuedAt: new Date(START - DAY_MS).toISOString(),
      expiresAt: new Date(START + 30 * DAY_MS).toISOString(),
      releases: [{ version: "1.4.0", status: "active", rolloutBp: 10000, notes: "Fixes", artifacts: { "windows-x86_64": { url: "https://downloads.example/vivah-1.4.0.msi", sha256: "b".repeat(64), size: 5000 } } }],
    }),
  );
  const publish = (h: Harness, name: string, bytes: Buffer, signature: unknown, headers?: Record<string, string>) =>
    h.call("PUT", `/admin/v1/documents/${name}`, { body: { bytesBase64: bytes.toString("base64"), signature }, admin: true, headers });
  const rawGet = async (h: Harness, route: string, headers: Record<string, string> = {}) => {
    const res = await h.fetchRaw(route, headers);
    return res;
  };

  it("serves exactly what was published to anyone, and what it serves still verifies against the publisher's key", async () => {
    const h = await start();
    const signature = signDocument(manifestBytes, { privateKey: signer.privateKey, kid: "k1", domain: MANIFEST_DOMAIN });
    expect((await publish(h, "updates-stable", manifestBytes, signature)).status).toBe(204);

    const doc = await rawGet(h, "/v1/documents/updates-stable");
    expect(doc.status).toBe(200);
    expect(doc.body.equals(manifestBytes)).toBe(true);
    expect(doc.headers.get("content-type")).toBe("application/octet-stream");
    expect(doc.headers.get("x-content-type-options")).toBe("nosniff");
    expect(doc.headers.get("cache-control")).toBe("public, max-age=300");
    const sig = await rawGet(h, "/v1/documents/updates-stable.sig");
    expect(sig.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(sig.body.toString())).toEqual(signature);

    const { manifest } = verifyManifest({ bytes: doc.body, signature: JSON.parse(sig.body.toString()), pinned: trusted, expectedChannel: "stable", now: START });
    expect(manifest.releases[0]!.version).toBe("1.4.0");
  });

  it("answers a client that already has the current copy with 304, and a new publication changes the tag", async () => {
    const h = await start();
    const signature = signDocument(manifestBytes, { privateKey: signer.privateKey, kid: "k1", domain: MANIFEST_DOMAIN });
    await publish(h, "updates-stable", manifestBytes, signature);
    const first = await rawGet(h, "/v1/documents/updates-stable");
    const tag = first.headers.get("etag")!;
    const again = await rawGet(h, "/v1/documents/updates-stable", { "if-none-match": tag });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);

    await publish(h, "updates-stable", Buffer.from(manifestBytes.toString().replace('"sequence":7', '"sequence":8')), signature);
    const changed = await rawGet(h, "/v1/documents/updates-stable", { "if-none-match": tag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(tag);
  });

  it("lets only the operator publish, and tells a client plainly when there is nothing", async () => {
    const h = await start();
    const signature = signDocument(manifestBytes, { privateKey: signer.privateKey, kid: "k1", domain: MANIFEST_DOMAIN });
    const body = { bytesBase64: manifestBytes.toString("base64"), signature };
    expect((await h.call("PUT", "/admin/v1/documents/updates-stable", { body })).status).toBe(401);
    expect((await h.call("PUT", "/admin/v1/documents/updates-stable", { body, admin: "wrong-key" })).status).toBe(401);
    expect((await h.call("PUT", "/v1/documents/updates-stable", { body, admin: true })).status).toBe(404);
    const missing = await h.call("GET", "/v1/documents/updates-stable");
    expect(missing.status).toBe(404);
    expect(missing.json.code).toBe("NOT_FOUND");
    expect((await h.call("GET", "/v1/documents/Updates")).status).toBe(404);
    expect((await h.call("GET", "/v1/documents/..%2Fsecrets")).status).toBe(404);
  });

  it("rejects what cannot be a document: bad names, bad base64, a wrong algorithm or signature size, extra fields, too much data", async () => {
    const h = await start();
    const good = signDocument(manifestBytes, { privateKey: signer.privateKey, kid: "k1", domain: MANIFEST_DOMAIN });
    const bytesBase64 = manifestBytes.toString("base64");
    const put = (name: string, body: unknown) => h.call("PUT", `/admin/v1/documents/${name}`, { body, admin: true });
    expect((await put("Bad_Name", { bytesBase64, signature: good })).status).toBe(400);
    expect((await put("x".repeat(41), { bytesBase64, signature: good })).status).toBe(400);
    expect((await put("ok", { bytesBase64: "not base64!!", signature: good })).status).toBe(400);
    expect((await put("ok", { bytesBase64: bytesBase64.slice(0, -2), signature: good })).status).toBe(400);
    expect((await put("ok", { bytesBase64, signature: { ...good, alg: "RS256" } })).status).toBe(400);
    expect((await put("ok", { bytesBase64, signature: { ...good, sig: "AAAA" } })).status).toBe(400);
    expect((await put("ok", { bytesBase64, signature: good, extra: 1 })).status).toBe(400);
    expect((await put("ok", { bytesBase64: Buffer.alloc(150 * 1024 + 1, 1).toString("base64"), signature: good })).status).toBe(400);
    expect((await h.call("PUT", "/admin/v1/documents/ok", { raw: "{}", headers: { "content-type": "text/plain" }, admin: true })).status).toBe(415);
    expect((await put("ok", { bytesBase64, signature: good })).status).toBe(204);
  });

  it("limits how often one client may fetch documents, and says when to retry", async () => {
    const h = await start();
    await publish(h, "config", manifestBytes, signDocument(manifestBytes, { privateKey: signer.privateKey, kid: "k1", domain: CONFIG_DOMAIN }));
    for (let i = 0; i < 120; i++) expect((await rawGet(h, "/v1/documents/config")).status).toBe(200);
    const limited = await rawGet(h, "/v1/documents/config");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    clock += 61_000;
    expect((await rawGet(h, "/v1/documents/config")).status).toBe(200);
  });
});

describe("on SQLite", () => {
  it("serves the same lifecycle from a durable store, including after a restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vivah-cloud-api-"));
    const file = path.join(dir, "cloud.db");
    const first = new SqliteCloudStore(file);
    const usage = { events: [{ eventId: "e1", at: new Date(START).toISOString(), photos: 3, llmCalls: 3, inputTokens: 1, outputTokens: 1, costUsd: 0.01 }] };
    try {
      const h = await start({ store: first });
      const c = await h.customer();
      const act = (await h.activate(c.licenseKey)).json;
      const put = await h.call("PUT", "/v1/style-profiles/warm", { token: act.refreshToken, body: { name: "Warm", blob: "QQ==" }, headers: { "if-none-match": "*" } });
      expect(put.status).toBe(201);
      await h.call("POST", "/v1/usage", { token: act.refreshToken, body: usage });
      await Promise.all(closers.map((x) => x()));
      closers = [];
      first.close();

      // A new server process on the same database still knows the device, the license and the profile.
      const second = new SqliteCloudStore(file);
      try {
        const h2 = await start({ store: second });
        expect((await h2.call("POST", "/v1/refresh", { token: act.refreshToken })).status).toBe(200);
        expect((await h2.call("GET", "/v1/style-profiles/warm", { token: act.refreshToken })).json.blob).toBe("QQ==");
        expect((await h2.call("POST", "/v1/usage", { token: act.refreshToken, body: usage })).json).toEqual({ accepted: 0, duplicates: 1 });
        // The first device's slot is still taken: a second device fits (cap 2), a third does not.
        expect((await h2.activate(c.licenseKey, "device-aaaa-0002", "Second")).status).toBe(200);
        expect((await h2.activate(c.licenseKey, "device-aaaa-0003", "Third")).status).toBe(409);
      } finally {
        await Promise.all(closers.map((x) => x()));
        closers = [];
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("secrets", () => {
  it("never appear in log output, and tokens are not stored in plaintext", async () => {
    const h = await start();
    const c = await h.customer();
    const act = (await h.activate(c.licenseKey)).json;
    await h.call("POST", "/v1/refresh", { token: act.refreshToken });
    await h.call("POST", "/v1/usage", { token: act.refreshToken, body: { events: [{ eventId: "e", at: new Date(START).toISOString(), photos: 1, llmCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 }] } });
    await h.webhook({ id: "evt_s", type: "subscription.upsert", data: { accountId: c.accountId, plan: "pro", seats: 1, status: "active" } });
    await h.call("GET", "/v1/nope", { token: "some-bad-token-value" });
    await h.activate("VL-AAAAA-AAAAA-AAAAA-AAAAB");

    const log = JSON.stringify(h.logs);
    expect(h.logs.length).toBeGreaterThan(5);
    for (const secret of [c.licenseKey, act.refreshToken, act.entitlementToken, ADMIN, WEBHOOK_SECRET, "some-bad-token-value"]) {
      expect(log).not.toContain(secret);
    }
    const stored = h.store.getActivationByRefreshHash(createHash("sha256").update(act.refreshToken).digest("hex"));
    expect(stored!.refreshTokenHash).not.toBe(act.refreshToken);
    expect(h.store.getLicenseByKeyHash(createHash("sha256").update(c.licenseKey).digest("hex"))!.keyHash).not.toContain(c.licenseKey);
  });
});
