import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudApi, MemoryCloudStore, type UsageEvent } from "@vivahlens/cloud-api";
import { runCli } from "./commands.js";
import { LicenseStore } from "./licenseClient.js";
import { logsDir } from "./logging.js";
import { SettingsStore } from "./settings.js";
import { reportUsage, type UsageTotals } from "./usageReport.js";

const DAY = 24 * 60 * 60 * 1000;
const ADMIN = "admin-key-for-telemetry-tests";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;

const root = mkdtempSync(path.join(tmpdir(), "vivah-telemetry-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

class SpyStore extends MemoryCloudStore {
  events: UsageEvent[] = [];
  override recordUsage(events: readonly UsageEvent[]) {
    this.events.push(...events);
    return super.recordUsage(events);
  }
}

const spy = new SpyStore();
let server: { port: number; close(): Promise<void> } | undefined;
let base = "";
beforeAll(async () => {
  const api = createCloudApi({ store: spy, signingKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string, adminKey: ADMIN, webhookSecret: "whsec_telemetry", rateLimits: { activatePerMinute: 1000, failedActivationsPerMinute: 1000, refreshPerIpPerMinute: 1000, refreshPerTokenPerMinute: 1000 } });
  server = await api.listen(0);
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => server?.close());

async function admin(method: string, route: string, body?: unknown) {
  const res = await fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}
let customers = 0;
async function licenseKey(): Promise<string> {
  const acct = await admin("POST", "/admin/v1/accounts", { email: `t${customers++}@example.com` });
  await admin("PUT", `/admin/v1/accounts/${acct.accountId}/subscription`, { plan: "pro", seats: 1, status: "active", currentPeriodEnd: new Date(Date.now() + 30 * DAY).toISOString() });
  return (await admin("POST", "/admin/v1/licenses", { accountId: acct.accountId })).licenseKey;
}

function photo(variant: number): Buffer {
  const [w, h] = [96, 64];
  const data = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.fill(Math.min(255, 50 + (variant ? w - 1 - x : x) * 2 + ((x + y) % 2) * 60), (y * w + x) * 4, (y * w + x) * 4 + 3);
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
}

let runs = 0;
async function machine(opts: { activate?: boolean } = {}) {
  const home = path.join(root, `home${runs++}`);
  // A machine that was never activated can only run as a development build, which enforces no license.
  const env = { VIVAH_HOME: home, VIVAH_SECRET_STORE: "none", ...(opts.activate !== false && { VIVAH_LICENSE_PUBLIC_KEY: PUBLIC_PEM }) };
  const lines: string[] = [];
  const run = (args: string[]) => runCli(args, { env, log: (l) => lines.push(l), info: (l) => lines.push(l) });
  if (opts.activate !== false) expect(await run(["activate", "--server", base, "--key", await licenseKey()])).toBe(0);
  const folder = path.join(root, `shoot${runs}`);
  mkdirSync(folder);
  writeFileSync(path.join(folder, "p0.jpg"), photo(0));
  writeFileSync(path.join(folder, "p1.jpg"), photo(1));
  const refs = path.join(root, `refs${runs}`);
  mkdirSync(refs);
  writeFileSync(path.join(refs, "r.jpg"), photo(0));
  const profile = path.join(root, `style${runs}.json`);
  expect(await runCli(["learn", "--refs", refs, "--name", "S", "--out", profile, "--provider", "mock"], { env: { VIVAH_HOME: home }, log: () => undefined, info: () => undefined })).toBe(0);
  const edit = () => run(["edit", "--folder", folder, "--profile", profile, "--provider", "mock", "--db", path.join(home, "jobs.db"), "--job", `job${runs}-${Date.now()}`]);
  return { env, home, lines, run, edit, settings: SettingsStore.fromEnv(env) };
}

describe("usage reporting", () => {
  it("sends nothing unless the person turned it on, and says so", async () => {
    const m = await machine();
    const before = spy.events.length;
    expect(await m.edit()).toBe(0);
    expect(spy.events.length).toBe(before);

    m.lines.length = 0;
    expect(await m.run(["telemetry"])).toBe(0);
    expect(m.lines[0]).toBe("Usage reporting is off.");
    expect(m.lines.join("\n")).toContain("If you turn it on with `vivah telemetry on`");
    expect(m.lines.join("\n")).toMatch(/photos: how many photos[\s\S]*costUsd: what the run cost/);
    expect(m.lines.join("\n")).toContain("Never sent: photos or previews, file or folder names, styles, keys");
  });

  it("sends one count-only event after each edit once turned on, and stops when turned off", async () => {
    const m = await machine();
    const before = spy.events.length;
    expect(await m.run(["telemetry", "on"])).toBe(0);
    expect(await m.settings.usageReporting()).toBe(true);
    expect(await m.edit()).toBe(0);

    expect(spy.events.length).toBe(before + 1);
    const event = spy.events.at(-1)!;
    expect(Object.keys(event).sort()).toEqual(["activationId", "at", "costUsd", "eventId", "inputTokens", "llmCalls", "outputTokens", "photos"]);
    expect(event).toMatchObject({ photos: 2, llmCalls: 2 });
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);

    expect(await m.run(["telemetry", "off"])).toBe(0);
    await m.edit();
    expect(spy.events.length).toBe(before + 1);
  });

  it("logs what happened to the report, in the same log as the run", async () => {
    const m = await machine();
    await m.run(["telemetry", "on"]);
    await m.edit();
    const records = readFileSync(path.join(logsDir(m.env), "vivah.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(records.find((r) => r.event === "usage-report")).toMatchObject({ outcome: "sent", command: "edit" });
  });

  it("does nothing, and says why, on a computer that is not activated", async () => {
    const m = await machine({ activate: false });
    await m.run(["telemetry", "on"]);
    expect(m.lines.join("\n")).toContain("This computer is not activated yet, so nothing is sent.");
    const before = spy.events.length;
    expect(await m.edit()).toBe(0);
    expect(spy.events.length).toBe(before);
  });
});

describe("a report that cannot be delivered", () => {
  const usage: UsageTotals = { photos: 3, llmCalls: 3, inputTokens: 100, outputTokens: 20, costUsd: 0.0123456789 };
  async function ready() {
    const home = path.join(root, `unit${runs++}`);
    const licenses = new LicenseStore(home, { secrets: undefined });
    await licenses.write({ server: base, activationId: "act", entitlementToken: "t", refreshToken: "rtok-1234567890" } as never);
    const settings = new SettingsStore(home);
    return { licenses, settings };
  }

  it("is off without the setting, and not sent without an activation", async () => {
    const { licenses, settings } = await ready();
    expect(await reportUsage({ settings, licenses, usage, fetch: (async () => { throw new Error("must not be called"); }) as typeof fetch })).toBe("off");
    await settings.update({ telemetry: { usage: true } });
    const blank = new LicenseStore(path.join(root, `blank${runs++}`), { secrets: undefined });
    expect(await reportUsage({ settings, licenses: blank, usage })).toBe("not-activated");
  });

  it("sends the refresh token as the credential and rounds the cost, and treats any failure as failed without throwing", async () => {
    const { licenses, settings } = await ready();
    await settings.update({ telemetry: { usage: true } });
    let seen: { url: string; auth: string | null; body: any } | undefined;
    const record = (status: number) => (async (url: URL, init: RequestInit) => {
      seen = { url: String(url), auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) };
      return new Response("{}", { status });
    }) as unknown as typeof fetch;
    expect(await reportUsage({ settings, licenses, usage, fetch: record(200), now: () => new Date(Date.UTC(2026, 10, 22)), newId: () => "evt-1" })).toBe("sent");
    expect(seen).toEqual({ url: `${base}/v1/usage`, auth: "Bearer rtok-1234567890", body: { events: [{ eventId: "evt-1", at: "2026-11-22T00:00:00.000Z", photos: 3, llmCalls: 3, inputTokens: 100, outputTokens: 20, costUsd: 0.012346 }] } });
    expect(await reportUsage({ settings, licenses, usage, fetch: record(401) })).toBe("failed");
    expect(await reportUsage({ settings, licenses, usage, fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch })).toBe("failed");
  });

  it("gives up after the timeout instead of holding the run up", async () => {
    const { licenses, settings } = await ready();
    await settings.update({ telemetry: { usage: true } });
    const hangs = ((_url: URL, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const started = Date.now();
    expect(await reportUsage({ settings, licenses, usage, fetch: hangs, timeoutMs: 50 })).toBe("failed");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("does not let an unreachable server fail the edit", async () => {
    const m = await machine();
    await m.run(["telemetry", "on"]);
    await server!.close();
    server = undefined;
    expect(await m.edit()).toBe(0);
    const records = readFileSync(path.join(logsDir(m.env), "vivah.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(records.find((r) => r.event === "usage-report")).toMatchObject({ outcome: "failed" });
  });
});

describe("settings", () => {
  it("default to everything off, survive a damaged file, and keep what was chosen", async () => {
    const dir = path.join(root, `settings${runs++}`);
    const settings = new SettingsStore(dir);
    expect(await settings.read()).toEqual({});
    expect(await settings.usageReporting()).toBe(false);
    await settings.update({ telemetry: { usage: true } });
    expect(await settings.usageReporting()).toBe(true);
    writeFileSync(settings.file, "{ not json");
    expect(await settings.usageReporting()).toBe(false);
    writeFileSync(settings.file, JSON.stringify({ telemetry: { usage: "yes" } }));
    expect(await settings.usageReporting()).toBe(false);
  });
});
