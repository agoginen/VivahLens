import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudApi, MemoryCloudStore } from "@vivahlens/cloud-api";
import { CONFIG_DOMAIN, MANIFEST_DOMAIN, rawPublicKey, signDocument } from "@vivahlens/core";
import { runCli } from "./commands.js";
import { loadRemoteConfig } from "./remoteConfigClient.js";
import { fetchSigned, installId, pinnedKeys, TrustState, Unreachable } from "./signedClient.js";
import { updateTarget } from "./updates.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ADMIN = "admin-key-for-signed-tests";
const publisher = generateKeyPairSync("ed25519");
const impostor = generateKeyPairSync("ed25519");
const KEYS = JSON.stringify({ k1: rawPublicKey(publisher.privateKey) });

const root = mkdtempSync(path.join(tmpdir(), "vivah-signed-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let server: { port: number; close(): Promise<void> } | undefined;
let base = "";
beforeAll(async () => {
  const api = createCloudApi({ store: new MemoryCloudStore(), signingKeyPem: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string, adminKey: ADMIN, webhookSecret: "whsec_signed", rateLimits: { documentsPerIpPerMinute: 100_000 } });
  server = await api.listen(0);
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => server?.close());

async function publish(name: string, doc: unknown, opts: { domain?: string; key?: typeof publisher.privateKey } = {}): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(doc));
  const signature = signDocument(bytes, { privateKey: opts.key ?? publisher.privateKey, kid: "k1", domain: opts.domain ?? (name === "config" ? CONFIG_DOMAIN : MANIFEST_DOMAIN) });
  const res = await fetch(`${base}/admin/v1/documents/${name}`, { method: "PUT", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ bytesBase64: bytes.toString("base64"), signature }) });
  expect(res.status).toBe(204);
}

const NOW = Date.now();
const release = (version: string, more: object = {}) => ({
  version,
  status: "active",
  rolloutBp: 10_000,
  notes: `What is new in ${version}`,
  artifacts: { [updateTarget()]: { url: `https://downloads.example/vivah-${version}.bin`, sha256: "c".repeat(64), size: 4 * 1024 * 1024 } },
  ...more,
});
const manifest = (channel: string, sequence: number, releases: object[], more: object = {}) => ({
  schema: 1,
  channel,
  sequence,
  issuedAt: new Date(NOW - HOUR).toISOString(),
  expiresAt: new Date(NOW + 30 * DAY).toISOString(),
  releases,
  ...more,
});
const config = (sequence: number, more: object = {}) => ({
  schema: 1,
  sequence,
  issuedAt: new Date(NOW - HOUR).toISOString(),
  expiresAt: new Date(NOW + 30 * DAY).toISOString(),
  ...more,
});

let machines = 0;
function machine(over: Record<string, string> = {}) {
  const home = path.join(root, `m${machines++}`);
  const lines: string[] = [];
  const env = { VIVAH_HOME: home, VIVAH_UPDATE_KEYS: KEYS, VIVAH_UPDATE_URL: base, ...over };
  const run = (args: string[], signal?: AbortSignal) => runCli(args, { env, log: (l) => lines.push(l), info: (l) => lines.push(l), ...(signal && { signal }) });
  return { home, env, lines, run, text: () => lines.join("\n") };
}

describe("vivah update", () => {
  it("is off in a build with no update keys", async () => {
    const m = machine({ VIVAH_UPDATE_KEYS: "" });
    expect(await m.run(["update"])).toBe(0);
    expect(m.text()).toContain("Update checks are off in this build because it has no update keys");
  });

  it("says plainly when nothing has been published, and when the server cannot be reached", async () => {
    const m = machine();
    expect(await m.run(["update", "--channel", "alpha"])).toBe(0);
    expect(m.text()).toContain("No update information has been published for the alpha channel yet.");
    const down = machine({ VIVAH_UPDATE_URL: "http://127.0.0.1:1" });
    expect(await down.run(["update"])).toBe(0);
    expect(down.text()).toMatch(/Could not check for updates \(.+\)\. Nothing was changed\./);
  });

  it("offers a newer verified release with its notes, link and checksum, and nothing when up to date", async () => {
    await publish("updates-stable", manifest("stable", 1, [release("1.4.0"), release("1.3.0")]));
    const m = machine();
    expect(await m.run(["update"])).toBe(0);
    const text = m.text();
    expect(text).toContain("Version 1.4.0 is available (you have 0.0.0; channel stable).");
    expect(text).toContain("What is new in 1.4.0");
    expect(text).toContain("Download: https://downloads.example/vivah-1.4.0.bin");
    expect(text).toContain(`SHA-256 ${"c".repeat(64)}, 4096 KB`);
    expect(text).toContain("does not replace itself yet");

    await publish("updates-stable", manifest("stable", 2, [release("0.0.0")]));
    const current = machine();
    await current.run(["update"]);
    expect(current.text()).toContain("You are up to date (0.0.0, channel stable).");
  });

  it("gives the same answer as JSON for a program to read", async () => {
    await publish("updates-stable", manifest("stable", 3, [release("2.0.0")]));
    const m = machine();
    await m.run(["update", "--json"]);
    const out = JSON.parse(m.text());
    expect(out).toMatchObject({ status: "available", currentVersion: "0.0.0", channel: "stable", offer: { kind: "update", channel: "stable", release: { version: "2.0.0" } } });
  });

  it("refuses a manifest that was not signed by a trusted key, as an error, not as 'no update'", async () => {
    await publish("updates-beta", manifest("beta", 1, [release("9.9.9")]), { key: impostor.privateKey });
    const m = machine();
    expect(await m.run(["update", "--channel", "beta"])).toBe(1);
    expect(m.text()).toContain("[SIGNED_DOCUMENT_INVALID] The signature does not match the document");
  });

  it("refuses an older manifest than one it has already accepted, so a server cannot roll it back", async () => {
    const m = machine();
    await publish("updates-alpha", manifest("alpha", 10, [release("3.0.0")]));
    expect(await m.run(["update", "--channel", "alpha"])).toBe(0);
    await publish("updates-alpha", manifest("alpha", 9, [release("1.0.0")]));
    expect(await m.run(["update", "--channel", "alpha"])).toBe(1);
    expect(m.text()).toContain("older than one already seen");
    // The newer one is still what this computer trusts.
    await publish("updates-alpha", manifest("alpha", 10, [release("3.0.0")]));
    expect(await m.run(["update", "--channel", "alpha"])).toBe(0);
  });

  it("treats a manifest that has run out as stale rather than as an attack, and offers nothing from it", async () => {
    await publish("updates-stable", manifest("stable", 4, [release("5.0.0")], { expiresAt: new Date(NOW - HOUR).toISOString() }));
    const m = machine();
    expect(await m.run(["update"])).toBe(0);
    expect(m.text()).toContain("The update information is out of date, so it was not used.");
    expect(m.text()).not.toContain("5.0.0");
  });

  it("holds a release back from installs outside its staged share, and offers it to those inside", async () => {
    await publish("updates-stable", manifest("stable", 5, [release("6.0.0", { rolloutBp: 0 })]));
    const out = machine();
    await out.run(["update"]);
    expect(out.text()).toContain("You are up to date");
    await publish("updates-stable", manifest("stable", 6, [release("6.0.0", { rolloutBp: 10_000 })]));
    const inside = machine();
    await inside.run(["update"]);
    expect(inside.text()).toContain("Version 6.0.0 is available");
  });

  it("on the beta channel also considers stable, and takes the newest", async () => {
    await publish("updates-stable", manifest("stable", 7, [release("7.1.0")]));
    await publish("updates-beta", manifest("beta", 2, [release("7.0.0-beta.2")]));
    const m = machine();
    await m.run(["update", "--channel", "beta"]);
    expect(m.text()).toContain("Version 7.1.0 is available (you have 0.0.0; channel stable).");
    await publish("updates-beta", manifest("beta", 3, [release("7.2.0-beta.1")]));
    const later = machine();
    await later.run(["update", "--channel", "beta"]);
    expect(later.text()).toContain("Version 7.2.0-beta.1 is available (you have 0.0.0; channel beta).");
  });

  it("moves an install off a withdrawn version, and only that one", async () => {
    await publish("updates-stable", manifest("stable", 8, [release("0.0.0"), release("0.0.1", { status: "withdrawn" })], { rollback: { from: ["0.0.0"], to: "0.0.0" } }));
    // The current version is 0.0.0; the manifest says go back to the active 0.0.0 release: an offer of the same version is a rollback only for those listed.
    const m = machine();
    await m.run(["update", "--json"]);
    expect(JSON.parse(m.text())).toMatchObject({ status: "available", offer: { kind: "rollback", release: { version: "0.0.0" } } });
  });

  it("rejects a bad channel", async () => {
    const m = machine();
    expect(await m.run(["update", "--channel", "nightly"])).toBe(1);
    expect(m.text()).toContain("--channel must be stable, beta or alpha");
  });
});

describe("the remote config in an edit", () => {
  function photo(variant: number): Buffer {
    const [w, h] = [96, 64];
    const data = Buffer.alloc(w * h * 4, 255);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.fill(Math.min(255, 50 + (variant ? w - 1 - x : x) * 2 + ((x + y) % 2) * 60), (y * w + x) * 4, (y * w + x) * 4 + 3);
    return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
  }
  let shoots = 0;
  function work() {
    const folder = path.join(root, `shoot${shoots++}`);
    mkdirSync(folder);
    writeFileSync(path.join(folder, "a.jpg"), photo(0));
    writeFileSync(path.join(folder, "b.jpg"), photo(1));
    const profile = path.join(folder, "..", `style${shoots}.json`);
    return { folder, profile };
  }
  async function learned(m: ReturnType<typeof machine>, profile: string) {
    const refs = path.join(root, `refs${shoots}`);
    mkdirSync(refs, { recursive: true });
    writeFileSync(path.join(refs, "r.jpg"), photo(0));
    expect(await m.run(["learn", "--refs", refs, "--name", "S", "--out", profile, "--provider", "mock"])).toBe(0);
  }

  it("stops an edit with the reason when the adapter is switched off, writes nothing, and still lets work be exported", async () => {
    await publish("config", config(1, { adapters: { "xmp-sidecar": { stage: "disabled", notice: "Paused: a Lightroom update changed how sidecars are read." } } }));
    const m = machine();
    const { folder, profile } = work();
    await learned(m, profile);
    const refused = await m.run(["edit", "--folder", folder, "--profile", profile, "--provider", "mock", "--db", path.join(m.home, "j.db")]);
    expect(refused).toBe(1);
    expect(m.text()).toContain("[ADAPTER_VERSION_UNSUPPORTED] Paused: a Lightroom update changed how sidecars are read.");
    expect(existsSync(path.join(folder, "a.xmp"))).toBe(false);

    m.lines.length = 0;
    await m.run(["export", "--folder", folder, "--approve-all", "--db", path.join(m.home, "j.db")]);
    expect(m.text()).toContain("Note: Paused: a Lightroom update changed how sidecars are read.");
    expect(m.text()).not.toContain("ADAPTER_VERSION_UNSUPPORTED");
  });

  it("says an adapter is in beta, and goes on", async () => {
    await publish("config", config(2, { adapters: { "xmp-sidecar": { stage: "beta", notice: "Tested with Lightroom 14.1." } } }));
    const m = machine();
    const { folder, profile } = work();
    await learned(m, profile);
    expect(await m.run(["edit", "--folder", folder, "--profile", profile, "--provider", "mock", "--db", path.join(m.home, "j.db")])).toBe(0);
    expect(m.text()).toContain('Note: "xmp-sidecar" is in beta. Tested with Lightroom 14.1.');
    expect(existsSync(path.join(folder, "a.xmp"))).toBe(true);
  });

  it("takes model prices from the signed catalog when none are given, and refuses a run over the cap before sending anything", async () => {
    await publish("config", config(3, { prices: { effectiveFrom: "2026-11-01", models: { cheap: { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000 } } } }));
    const m = machine({ OPENAI_API_KEY: "k" });
    const { folder, profile } = work();
    await learned(m, profile);
    m.lines.length = 0;
    const over = await m.run(["edit", "--folder", folder, "--profile", profile, "--provider", "openai", "--model", "cheap", "--max-cost", "1", "--db", path.join(m.home, "j.db")]);
    expect(over).toBe(1);
    expect(m.text()).toContain("prices effective 2026-11-01, from the signed remote catalog");
    expect(m.text()).toContain("exceeds --max-cost 1; nothing was sent.");
  });

  it("refuses a cap it cannot check, instead of quietly not protecting anyone", async () => {
    await publish("config", config(4, { prices: { effectiveFrom: "2026-11-01", models: { other: { inputPerMTok: 1, outputPerMTok: 1 } } } }));
    const m = machine({ OPENAI_API_KEY: "k" });
    const { folder, profile } = work();
    await learned(m, profile);
    m.lines.length = 0;
    const args = ["edit", "--folder", folder, "--profile", profile, "--provider", "openai", "--model", "cheap", "--db", path.join(m.home, "j.db")];
    expect(await m.run([...args, "--max-cost", "5"])).toBe(1);
    expect(m.text()).toContain('--max-cost 5 cannot be checked: model "cheap" is not in the price table. Nothing was sent.');
    // The person's own price file always wins over the catalog.
    const own = path.join(root, "own-prices.json");
    writeFileSync(own, JSON.stringify({ effectiveFrom: "2026-01-01", models: { cheap: { inputPerMTok: 1000, outputPerMTok: 1000 } } }));
    m.lines.length = 0;
    expect(await m.run([...args, "--max-cost", "0.000001", "--prices", own])).toBe(1);
    expect(m.text()).toContain("prices effective 2026-01-01;");
    expect(m.text()).not.toContain("remote catalog");
  });
});

describe("loading the remote config", () => {
  const dirOf = () => path.join(root, `cfg${machines++}`);
  const counting = () => {
    const seen: string[] = [];
    const wrapped = ((url: URL, init?: RequestInit) => {
      seen.push(String(url));
      return fetch(url, init);
    }) as typeof fetch;
    return { seen, fetch: wrapped };
  };
  const env = { VIVAH_UPDATE_KEYS: KEYS };

  it("fetches once, keeps a copy for a day and uses it without asking again, and asks again when the copy is old", async () => {
    await publish("config", config(10, { adapters: { x: { stage: "beta" } } }));
    const dir = dirOf();
    const c = counting();
    const t0 = Date.now();
    const first = await loadRemoteConfig({ env, dir, baseUrl: base, fetch: c.fetch, now: () => t0 });
    expect(first.config?.adapters?.x?.stage).toBe("beta");
    expect(c.seen).toHaveLength(2); // the document and its signature
    const again = await loadRemoteConfig({ env, dir, baseUrl: base, fetch: c.fetch, now: () => t0 + 2 * HOUR });
    expect(again.config?.sequence).toBe(10);
    expect(c.seen).toHaveLength(2);
    await loadRemoteConfig({ env, dir, baseUrl: base, fetch: c.fetch, now: () => t0 + 25 * HOUR });
    expect(c.seen).toHaveLength(4);
  });

  it("uses only the saved copy when offline, and contacts nothing without update keys or a server", async () => {
    const dir = dirOf();
    const c = counting();
    await loadRemoteConfig({ env, dir, baseUrl: base, fetch: c.fetch });
    const calls = c.seen.length;
    expect((await loadRemoteConfig({ env, dir, baseUrl: base, fetch: c.fetch, offline: true, now: () => Date.now() + 5 * DAY })).config?.sequence).toBe(10);
    expect(await loadRemoteConfig({ env: {}, dir: dirOf(), baseUrl: base, fetch: c.fetch })).toEqual({});
    expect(await loadRemoteConfig({ env, dir: dirOf(), fetch: c.fetch })).toEqual({});
    expect(c.seen).toHaveLength(calls);
  });

  it("keeps the last good copy when the server is down, and ignores one that has expired", async () => {
    const dir = dirOf();
    await loadRemoteConfig({ env, dir, baseUrl: base });
    const down = await loadRemoteConfig({ env, dir, baseUrl: "http://127.0.0.1:1", now: () => Date.now() + 2 * DAY });
    expect(down.config?.sequence).toBe(10);
    expect(down.note).toBeUndefined();
    const expired = await loadRemoteConfig({ env, dir, baseUrl: "http://127.0.0.1:1", now: () => Date.now() + 60 * DAY });
    expect(expired.config).toBeUndefined();
  });

  it("refuses a config that was not signed by a trusted key or that is older than the one it has, keeping the good copy and saying so", async () => {
    const dir = dirOf();
    await loadRemoteConfig({ env, dir, baseUrl: base });
    await publish("config", config(11), { key: impostor.privateKey });
    const forged = await loadRemoteConfig({ env, dir, baseUrl: base, now: () => Date.now() + 2 * DAY });
    expect(forged.config?.sequence).toBe(10);
    expect(forged.note).toMatch(/remote settings were refused \(The signature does not match the document\)/);

    await publish("config", config(9));
    const older = await loadRemoteConfig({ env, dir, baseUrl: base, now: () => Date.now() + 2 * DAY });
    expect(older.config?.sequence).toBe(10);
    expect(older.note).toMatch(/older than one already seen/);
    await publish("config", config(10, { adapters: { x: { stage: "beta" } } }));
  });

  it("does not trust a saved copy that was edited on disk", async () => {
    const dir = dirOf();
    await loadRemoteConfig({ env, dir, baseUrl: base });
    const file = path.join(dir, "remote-config.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const doc = JSON.parse(Buffer.from(saved.bytesBase64, "base64").toString());
    doc.adapters = { "xmp-sidecar": { stage: "stable" } };
    writeFileSync(file, JSON.stringify({ ...saved, bytesBase64: Buffer.from(JSON.stringify(doc)).toString("base64") }));
    expect((await loadRemoteConfig({ env, dir, offline: true })).config).toBeUndefined();
  });

  it("says what is wrong with the update keys instead of failing a run", async () => {
    const result = await loadRemoteConfig({ env: { VIVAH_UPDATE_KEYS: "{ nope" }, dir: dirOf(), baseUrl: base });
    expect(result.note).toMatch(/^Remote settings are off: VIVAH_UPDATE_KEYS is not usable/);
  });
});

describe("fetching signed documents safely", () => {
  it("returns nothing for a name that was never published, and needs both the document and its signature", async () => {
    expect(await fetchSigned({ baseUrl: base, name: "never-published" })).toBeUndefined();
    const half = (async (url: URL) => (String(url).endsWith(".sig") ? new Response("nope", { status: 404 }) : new Response("body"))) as unknown as typeof fetch;
    expect(await fetchSigned({ baseUrl: base, name: "x", fetch: half })).toBeUndefined();
  });

  it("refuses plain http except to this computer", async () => {
    await expect(fetchSigned({ baseUrl: "http://updates.example.com", name: "x" })).rejects.toThrow(/must be an https address/);
    await expect(fetchSigned({ baseUrl: "ftp://updates.example.com", name: "x" })).rejects.toThrow(/must be an https address/);
  });

  it("reports a failing or unreachable server as unreachable, and a signature file that is not JSON as invalid", async () => {
    const failing = (async () => new Response("oops", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchSigned({ baseUrl: base, name: "x", fetch: failing })).rejects.toBeInstanceOf(Unreachable);
    await expect(fetchSigned({ baseUrl: "http://127.0.0.1:1", name: "x" })).rejects.toBeInstanceOf(Unreachable);
    const garbled = (async () => new Response("not json")) as unknown as typeof fetch;
    await expect(fetchSigned({ baseUrl: base, name: "x", fetch: garbled })).rejects.toThrow(/not valid JSON/);
  });

  it("gives up on a document bigger than any real one, however it announces its size, and on a server that never answers", async () => {
    const huge = (async () => new Response(Buffer.alloc(300 * 1024, 1))) as unknown as typeof fetch;
    await expect(fetchSigned({ baseUrl: base, name: "x", fetch: huge })).rejects.toThrow(/larger than any real one/);
    const lying = (async () => new Response("x", { headers: { "content-length": "999999" } })) as unknown as typeof fetch;
    await expect(fetchSigned({ baseUrl: base, name: "x", fetch: lying })).rejects.toThrow(/larger than any real one/);
    const hangs = ((_url: URL, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const started = Date.now();
    await expect(fetchSigned({ baseUrl: base, name: "x", fetch: hangs, timeoutMs: 50 })).rejects.toBeInstanceOf(Unreachable);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("trust on this computer", () => {
  it("reads update keys from the environment as JSON or from a file, and refuses anything else", async () => {
    expect(await pinnedKeys({})).toEqual({});
    expect(await pinnedKeys({ VIVAH_UPDATE_KEYS: KEYS })).toEqual(JSON.parse(KEYS));
    const file = path.join(root, "keys.json");
    writeFileSync(file, KEYS);
    expect(await pinnedKeys({ VIVAH_UPDATE_KEYS: file })).toEqual(JSON.parse(KEYS));
    await expect(pinnedKeys({ VIVAH_UPDATE_KEYS: '{"k1": 5}' })).rejects.toThrow(/JSON object of key id to base64 public key/);
    await expect(pinnedKeys({ VIVAH_UPDATE_KEYS: path.join(root, "missing.json") })).rejects.toThrow(/not usable/);
  });

  it("keeps one random install id per computer, and makes a new one if the file is damaged", async () => {
    const dir = path.join(root, `id${machines++}`);
    const id = await installId(dir);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(await installId(dir)).toBe(id);
    writeFileSync(path.join(dir, "install-id"), "garbage");
    expect(await installId(dir)).toMatch(/^[0-9a-f]{32}$/);
    expect(await installId(dir)).not.toBe("garbage");
  });

  it("remembers the newest document accepted, and starts clean from a missing or damaged file", async () => {
    const dir = path.join(root, `trust${machines++}`);
    const trust = new TrustState(dir);
    expect(await trust.read()).toEqual({ manifests: {} });
    await trust.save((r) => {
      r.manifests.stable = { lastSequence: 4, lastSha256: "ab" };
      r.config = { lastSequence: 2 };
    });
    expect(await trust.read()).toEqual({ manifests: { stable: { lastSequence: 4, lastSha256: "ab" } }, config: { lastSequence: 2 } });
    writeFileSync(trust.file, JSON.stringify({ manifests: { stable: { lastSequence: "four" }, beta: { lastSequence: 1 } }, config: "x" }));
    expect(await trust.read()).toEqual({ manifests: { beta: { lastSequence: 1 } } });
    writeFileSync(trust.file, "{ broken");
    expect(await trust.read()).toEqual({ manifests: {} });
  });
});
