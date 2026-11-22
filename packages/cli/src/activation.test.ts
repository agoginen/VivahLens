import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCloudApi, MemoryCloudStore } from "@vivahlens/cloud-api";
import { accessFor, assertAllowed, isCurrentUserOnly, MemorySecretStore, SecretStoreError, type SecretStore } from "@vivahlens/core";
import { runCli } from "./commands.js";
import { requireLicense } from "./license.js";
import { activate, currentEntitlement, deactivate, LicenseStore } from "./licenseClient.js";

const DAY = 24 * 60 * 60 * 1000;
const ADMIN = "admin-key-for-integration-tests";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;

const root = mkdtempSync(path.join(tmpdir(), "vivah-activation-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Server clock = real time + offset, so tests can make a token look nearly expired without waiting. */
let offsetMs = 0;
let server: { port: number; close(): Promise<void> } | undefined;
let base = "";
let homes = 0;

beforeAll(async () => {
  const api = createCloudApi({
    store: new MemoryCloudStore(),
    signingKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    adminKey: ADMIN,
    webhookSecret: "whsec_integration",
    now: () => Date.now() + offsetMs,
    // Many machines activate from one address in these tests; abuse limits are covered in the cloud-api suite.
    rateLimits: { activatePerMinute: 10_000, failedActivationsPerMinute: 10_000, refreshPerIpPerMinute: 10_000, refreshPerTokenPerMinute: 10_000 },
  });
  server = await api.listen(0);
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => server?.close());
afterEach(() => {
  offsetMs = 0;
});

async function admin(method: string, route: string, body?: unknown) {
  const res = await fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

let customers = 0;
async function customer(plan = "pro", status = "active") {
  const { json: acct } = await admin("POST", "/admin/v1/accounts", { email: `person${customers++}@example.com` });
  await admin("PUT", `/admin/v1/accounts/${acct.accountId}/subscription`, { plan, seats: 1, status, currentPeriodEnd: new Date(Date.now() + 30 * DAY).toISOString() });
  const { json: lic } = await admin("POST", "/admin/v1/licenses", { accountId: acct.accountId });
  return { accountId: acct.accountId as string, licenseKey: lic.licenseKey as string };
}

const newHome = () => new LicenseStore(path.join(root, `home${homes++}`));

describe("activating and using the license", () => {
  it("binds the machine, keeps a private refresh token, and enforces the plan's adapters", async () => {
    const { licenseKey } = await customer("starter");
    const store = newHome();
    const license = await activate({ store, server: base, licenseKey, deviceName: "Test PC" });
    expect(license.refreshToken).not.toBe("");
    // Same device id on every call from this machine, and a user-private file.
    expect(await store.deviceId()).toBe(await store.deviceId());
    if (process.platform !== "win32") expect(statSync(path.join(store.dir, "license.json")).mode & 0o077).toBe(0);

    const env = { VIVAH_LICENSE_PUBLIC_KEY: PUBLIC_PEM };
    const edit = (adapterId: string) => ({ adapterId, operation: "edit" as const });
    expect((await requireLicense(env, undefined, edit("xmp-sidecar"), { store })).line).toMatch(/starter plan, valid until \d{4}-\d{2}-\d{2}\.$/);
    // The starter plan includes one adapter only.
    await expect(requireLicense(env, undefined, edit("rawtherapee"), { store })).rejects.toMatchObject({ code: "ENTITLEMENT_INVALID" });
  });

  it("explains refused activations", async () => {
    const { licenseKey } = await customer();
    const bad = await activate({ store: newHome(), server: base, licenseKey: "VL-AAAAA-AAAAA-AAAAA-AAAAA", deviceName: "x" }).catch((e) => e);
    expect(bad).toMatchObject({ code: "ENTITLEMENT_INVALID", message: "The license key is not valid." });

    const lapsed = await customer("pro", "canceled");
    await admin("PUT", `/admin/v1/accounts/${lapsed.accountId}/subscription`, { plan: "pro", seats: 1, status: "canceled", currentPeriodEnd: new Date(Date.now() - DAY).toISOString() });
    await expect(activate({ store: newHome(), server: base, licenseKey: lapsed.licenseKey, deviceName: "x" })).rejects.toMatchObject({ code: "ENTITLEMENT_EXPIRED" });

    await expect(activate({ store: newHome(), server: "http://127.0.0.1:1", licenseKey, deviceName: "x" })).rejects.toThrow(/Could not reach the license server/);
    // A third device on a two-device license is refused with the server's message.
    await activate({ store: newHome(), server: base, licenseKey, deviceName: "a" });
    await activate({ store: newHome(), server: base, licenseKey, deviceName: "b" });
    await expect(activate({ store: newHome(), server: base, licenseKey, deviceName: "c" })).rejects.toThrow(/already active on 2 device/);
  });
});

describe("refreshing, offline use and revocation", () => {
  async function nearlyExpired() {
    const { licenseKey, accountId } = await customer();
    offsetMs = -(7 * DAY - 12 * 60 * 60 * 1000); // the token will have 12 hours left
    const store = newHome();
    await activate({ store, server: base, licenseKey, deviceName: "Laptop" });
    offsetMs = 0;
    return { store, accountId, licenseKey };
  }

  it("keeps a comfortably valid token without calling the server", async () => {
    const { licenseKey } = await customer();
    const store = newHome();
    await activate({ store, server: base, licenseKey, deviceName: "Laptop" });
    const noNetwork = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const r = await currentEntitlement({ store, publicKey: PUBLIC_PEM, fetch: noNetwork });
    expect(r).toMatchObject({ status: "active", refreshed: false, offline: false });
  });

  it("renews a token that is close to expiry, and saves the new one", async () => {
    const { store } = await nearlyExpired();
    const before = (await store.read())!.entitlementToken;
    const first = await currentEntitlement({ store, publicKey: PUBLIC_PEM });
    expect(first).toMatchObject({ status: "active", refreshed: true, offline: false });
    expect(first.entitlement.expiresAt - Date.now()).toBeGreaterThan(6 * DAY);
    expect((await store.read())!.entitlementToken).not.toBe(before);
    expect((await currentEntitlement({ store, publicKey: PUBLIC_PEM })).refreshed).toBe(false);
  });

  it("carries on from the saved license when the server is unreachable or failing, until it truly expires", async () => {
    const { store } = await nearlyExpired();
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const offline = await currentEntitlement({ store, publicKey: PUBLIC_PEM, fetch: down });
    expect(offline).toMatchObject({ status: "active", offline: true, refreshed: false });

    const failing = (async () => new Response("oops", { status: 503 })) as typeof fetch;
    expect((await currentEntitlement({ store, publicKey: PUBLIC_PEM, fetch: failing })).offline).toBe(true);
    const limited = (async () => new Response("{}", { status: 429 })) as typeof fetch;
    expect((await currentEntitlement({ store, publicKey: PUBLIC_PEM, fetch: limited })).offline).toBe(true);

    // Past its expiry the saved token keeps working while the computer is offline, for the 14-day window.
    const later = await currentEntitlement({ store, publicKey: PUBLIC_PEM, fetch: down, now: () => Date.now() + DAY });
    expect(later.status).toBe("grace");
    expect(accessFor(later)).toMatchObject({ access: "full" });
    expect(() => assertAllowed(later, { operation: "edit", adapterId: "xmp-sidecar" })).not.toThrow();

    // Beyond that, editing pauses until the server confirms the subscription, but exporting still works.
    const muchLater = await currentEntitlement({ store, publicKey: PUBLIC_PEM, fetch: down, now: () => Date.now() + 16 * DAY });
    expect(muchLater.status).toBe("expired");
    expect(() => assertAllowed(muchLater, { operation: "edit", adapterId: "xmp-sidecar" })).toThrowError(expect.objectContaining({ code: "ENTITLEMENT_EXPIRED" }));
    expect(assertAllowed(muchLater, { operation: "export", adapterId: "xmp-sidecar" }).access).toBe("export-only");
  });

  it("believes the server immediately when the subscription lapsed or the device was removed, pausing editing but not exporting", async () => {
    const lapsed = await nearlyExpired();
    await admin("PUT", `/admin/v1/accounts/${lapsed.accountId}/subscription`, { plan: "pro", seats: 1, status: "canceled", currentPeriodEnd: new Date(Date.now() - DAY).toISOString() });
    const lapsedNow = await currentEntitlement({ store: lapsed.store, publicKey: PUBLIC_PEM });
    expect(lapsedNow).toMatchObject({ suspended: "subscription", status: "active" });
    expect(() => assertAllowed(lapsedNow, { operation: "edit", adapterId: "xmp-sidecar" })).toThrowError(expect.objectContaining({ code: "ENTITLEMENT_EXPIRED" }));
    expect(assertAllowed(lapsedNow, { operation: "export", adapterId: "xmp-sidecar" })).toMatchObject({ access: "export-only", reason: "subscription" });

    const removed = await nearlyExpired();
    const { json: summary } = await admin("GET", `/admin/v1/accounts/${removed.accountId}`);
    await admin("POST", `/admin/v1/activations/${summary.licenses[0].activations[0].id}/revoke`);
    const removedNow = await currentEntitlement({ store: removed.store, publicKey: PUBLIC_PEM });
    expect(removedNow).toMatchObject({ suspended: "device" });
    expect(() => assertAllowed(removedNow, { operation: "edit", adapterId: "xmp-sidecar" })).toThrow(/no longer activated/);
    expect(assertAllowed(removedNow, { operation: "export", adapterId: "xmp-sidecar" }).reason).toBe("device");
  });

  it("deactivating frees the slot on the server and forgets the license here", async () => {
    const { licenseKey } = await customer();
    const a = newHome();
    const b = newHome();
    await activate({ store: a, server: base, licenseKey, deviceName: "a" });
    await activate({ store: b, server: base, licenseKey, deviceName: "b" });
    expect(await deactivate({ store: a })).toEqual({ serverNotified: true });
    expect(await a.read()).toBeUndefined();
    await expect(deactivate({ store: a })).rejects.toThrow(/not activated/);
    // The freed slot lets a third machine in.
    await activate({ store: newHome(), server: base, licenseKey, deviceName: "c" });
  });
});

describe("vivah activate / license / deactivate", () => {
  function cli(args: string[], env: Record<string, string>) {
    const lines: string[] = [];
    return runCli(args, { env, log: (l) => lines.push(l) }).then((code) => ({ code, out: lines.join("\n") }));
  }

  it("runs the whole flow from the command line, and gates commands on the license", async () => {
    const { licenseKey } = await customer("pro");
    const home = path.join(root, "cli-home");
    const env = { VIVAH_HOME: home, VIVAH_LICENSE_PUBLIC_KEY: PUBLIC_PEM };

    expect((await cli(["license"], env)).out).toContain("not activated");
    const denied = await cli(["export", "--folder", root, "--approve-all", "--db", path.join(root, "x.db")], env);
    expect(denied.code).toBe(1);
    expect(denied.out).toContain("[ENTITLEMENT_INVALID]");

    const activated = await cli(["activate", "--server", base, "--key", licenseKey, "--device-name", "Studio"], env);
    expect(activated.code).toBe(0);
    expect(activated.out).toMatch(/Activated this computer: pro plan \(1 seat\), adapters: xmp-sidecar, rawtherapee, darktable, lightroom-classic, builtin-render, video-timeline/);
    const status = await cli(["license"], env);
    expect(status).toMatchObject({ code: 0 });
    expect(status.out).toContain("status: active");

    const allowed = await cli(["export", "--folder", root, "--approve-all", "--db", path.join(root, "y.db")], env);
    expect(allowed.out).toContain("License: pro plan");

    const gone = await cli(["deactivate"], env);
    expect(gone.out).toContain("Deactivated. This computer's license slot is free.");
    expect((await cli(["license"], env)).code).toBe(1);
  });

  it("shows editing as paused when the server says the subscription ended, yet still lets work be exported", async () => {
    const { licenseKey, accountId } = await customer("pro");
    const env = { VIVAH_HOME: path.join(root, "cli-home-lapsed"), VIVAH_LICENSE_PUBLIC_KEY: PUBLIC_PEM };
    // The token has 12 hours left, so the command asks the server (as it does within a day of expiry).
    offsetMs = -(7 * DAY - 12 * 60 * 60 * 1000);
    expect((await cli(["activate", "--server", base, "--key", licenseKey], env)).code).toBe(0);
    offsetMs = 0;
    await admin("PUT", `/admin/v1/accounts/${accountId}/subscription`, { plan: "pro", seats: 1, status: "canceled", currentPeriodEnd: new Date(Date.now() - DAY).toISOString() });

    const status = await cli(["license"], env);
    expect(status.code).toBe(1);
    expect(status.out).toContain("status: editing paused (subscription inactive); you can still export, deliver and undo");

    const exported = await cli(["export", "--folder", root, "--approve-all", "--db", path.join(root, "lapsed.db")], env);
    expect(exported.out).toContain("License: pro plan. Editing is paused: the subscription is not active. You can still export, deliver and undo.");
    expect(exported.out).not.toContain("[ENTITLEMENT");
  });

  it("needs a server and a key, and says so in a development build", async () => {
    expect((await cli(["activate", "--key", "x"], { VIVAH_HOME: path.join(root, "h1") })).out).toContain("--server is required");
    expect((await cli(["activate", "--server", base], { VIVAH_HOME: path.join(root, "h2") })).out).toContain("--key is required");
    const { licenseKey } = await customer();
    const dev = await cli(["activate", "--server", base, "--key", licenseKey], { VIVAH_HOME: path.join(root, "h3") });
    expect(dev.out).toContain("signature was not checked");
  });

  it("says where the sign-in is kept: the system's protected storage, or a private file when it is switched off", async () => {
    const { licenseKey } = await customer("pro");
    const file = await cli(["activate", "--server", base, "--key", licenseKey], { VIVAH_HOME: path.join(root, "h4"), VIVAH_SECRET_STORE: "none" });
    expect(file.out).toContain("kept in a file only your account can read");
    expect(JSON.parse(readFileSync(path.join(root, "h4", "license.json"), "utf8"))).toMatchObject({ refreshTokenIn: "file", refreshToken: expect.any(String) });
  });
});

describe("where the refresh token is kept", () => {
  /** A secret store that counts how often it is used, so a test can show when it is left alone. */
  function countingStore(over: Partial<{ failSet: boolean }> = {}) {
    const inner = new MemorySecretStore();
    const calls: string[] = [];
    const store: SecretStore = {
      backend: "memory",
      get: async (s, a) => (calls.push("get"), inner.get(s, a)),
      set: async (s, a, v) => {
        calls.push("set");
        if (over.failSet) throw new SecretStoreError("unavailable", "no keyring");
        return inner.set(s, a, v);
      },
      delete: async (s, a) => (calls.push("delete"), inner.delete(s, a)),
    };
    return { store, calls, inner };
  }
  const homeWith = (secrets: SecretStore | undefined) => new LicenseStore(path.join(root, `kept${homes++}`), secrets ? { secrets: async () => secrets } : {});

  it("keeps it out of the license file when there is a secret store, and reads it back only when it is needed", async () => {
    const { licenseKey } = await customer("pro");
    const { store: secrets, calls, inner } = countingStore();
    const store = homeWith(secrets);
    const license = await activate({ store, server: base, licenseKey, deviceName: "Laptop" });
    expect(license.refreshTokenIn).toBe("store");
    const onDisk = readFileSync(path.join(store.dir, "license.json"), "utf8");
    expect(onDisk).not.toContain(license.refreshToken);
    expect(JSON.parse(onDisk)).toMatchObject({ refreshTokenIn: "store" });
    expect(await inner.get("vivahlens", "refresh-token")).toBe(license.refreshToken);

    calls.length = 0;
    expect(await currentEntitlement({ store, publicKey: PUBLIC_PEM })).toMatchObject({ status: "active", refreshed: false });
    expect(calls).toEqual([]); // a comfortably valid license never touches the secret store
    expect((await store.read())!.refreshToken).toBe(license.refreshToken);
    expect(calls).toEqual(["get"]);
  });

  it("uses it to renew a token that is close to expiry, keeping it in the store", async () => {
    const { licenseKey } = await customer("pro");
    offsetMs = -(7 * DAY - 12 * 60 * 60 * 1000);
    const { store: secrets, calls } = countingStore();
    const store = homeWith(secrets);
    await activate({ store, server: base, licenseKey, deviceName: "Laptop" });
    offsetMs = 0;
    calls.length = 0;
    expect(await currentEntitlement({ store, publicKey: PUBLIC_PEM })).toMatchObject({ refreshed: true });
    expect(calls).toEqual(["get"]);
    expect(JSON.parse(readFileSync(path.join(store.dir, "license.json"), "utf8"))).toMatchObject({ refreshTokenIn: "store" });
    expect(JSON.parse(readFileSync(path.join(store.dir, "license.json"), "utf8"))).not.toHaveProperty("refreshToken");
  });

  it("asks to activate again when the stored sign-in has gone missing, rather than failing in some other way", async () => {
    const { licenseKey } = await customer("pro");
    offsetMs = -(7 * DAY - 12 * 60 * 60 * 1000);
    const { store: secrets, inner } = countingStore();
    const store = homeWith(secrets);
    await activate({ store, server: base, licenseKey, deviceName: "Laptop" });
    offsetMs = 0;
    await inner.delete("vivahlens", "refresh-token");
    await expect(currentEntitlement({ store, publicKey: PUBLIC_PEM })).rejects.toThrow(/saved sign-in is missing/);
    // Opened without any secret store at all, the same file is simply unreadable rather than half-working.
    expect(await new LicenseStore(store.dir).read()).toBeUndefined();
  });

  it("falls back to the private file when the secret store cannot be used, and forgets everything on deactivate", async () => {
    const { licenseKey } = await customer("pro");
    const broken = countingStore({ failSet: true });
    const store = homeWith(broken.store);
    const license = await activate({ store, server: base, licenseKey, deviceName: "Laptop" });
    expect(license.refreshTokenIn).toBe("file");
    expect(JSON.parse(readFileSync(path.join(store.dir, "license.json"), "utf8"))).toMatchObject({ refreshTokenIn: "file", refreshToken: license.refreshToken });
    expect((await store.read())!.refreshToken).toBe(license.refreshToken);

    const working = countingStore();
    const second = homeWith(working.store);
    await activate({ store: second, server: base, licenseKey, deviceName: "Desktop" });
    expect(await deactivate({ store: second })).toEqual({ serverNotified: true });
    expect(await working.inner.get("vivahlens", "refresh-token")).toBeUndefined();
    expect(existsSync(path.join(second.dir, "license.json"))).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("restricts the license and device files to the current user on Windows, where a file mode does nothing", async () => {
    const { licenseKey } = await customer("pro");
    const store = homeWith(undefined);
    await activate({ store, server: base, licenseKey, deviceName: "Laptop" });
    expect(await isCurrentUserOnly(path.join(store.dir, "license.json"))).toBe(true);
    expect(await isCurrentUserOnly(path.join(store.dir, "device.json"))).toBe(true);
  }, 30_000);

  it.skipIf(process.platform === "win32")("creates the license and device files readable by the current user only on POSIX", async () => {
    const { licenseKey } = await customer("pro");
    const store = homeWith(undefined);
    await activate({ store, server: base, licenseKey, deviceName: "Laptop" });
    for (const name of ["license.json", "device.json"]) expect(statSync(path.join(store.dir, name)).mode & 0o777).toBe(0o600);
  });
});
