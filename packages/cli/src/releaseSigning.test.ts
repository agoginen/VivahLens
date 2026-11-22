import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudApi, MemoryCloudStore } from "@vivahlens/cloud-api";
import { runCli } from "./commands.js";
import { updateTarget } from "./updates.js";

const script = fileURLToPath(new URL("../../../scripts/signing.mjs", import.meta.url));
// The script runs against the built packages, as it does in a release; without a build there is nothing to rehearse.
const built = existsSync(fileURLToPath(new URL("../../core/dist/index.js", import.meta.url)));

const root = mkdtempSync(path.join(tmpdir(), "vivah-release-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function exec(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { ...process.env, ...env }, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

const ADMIN = "admin-key-for-release-rehearsal";
let server: { port: number; close(): Promise<void> } | undefined;
let base = "";
beforeAll(async () => {
  const api = createCloudApi({ store: new MemoryCloudStore(), signingKeyPem: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string, adminKey: ADMIN, webhookSecret: "whsec_release" });
  server = await api.listen(0);
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => server?.close());

const manifest = (channel: string, sequence: number, version: string) => ({
  schema: 1,
  channel,
  sequence,
  issuedAt: new Date(Date.now() - 3_600_000).toISOString(),
  expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  releases: [{ version, status: "active", rolloutBp: 10_000, notes: `Release ${version}`, artifacts: { [updateTarget()]: { url: `https://downloads.example/vivah-${version}.msi`, sha256: "d".repeat(64), size: 8 * 1024 * 1024 } } }],
});

describe.skipIf(!built)("the release signing script", () => {
  const key = path.join(root, "signing.pem");
  let keys = "";

  it("makes a key that only its owner can read, prints the public half for the app, and never overwrites a key", async () => {
    const made = await exec(["keygen", "--out", key, "--kid", "release-2026"]);
    expect(made.code).toBe(0);
    expect(made.stdout).toContain("Keep it off any server");
    const printed = /VIVAH_UPDATE_KEYS or the embedded list\): (\{.*\})/.exec(made.stdout)![1]!;
    keys = printed;
    expect(Object.keys(JSON.parse(printed))).toEqual(["release-2026"]);
    expect(Buffer.from(JSON.parse(printed)["release-2026"], "base64")).toHaveLength(32);
    expect(readFileSync(key, "utf8")).toContain("BEGIN PRIVATE KEY");

    const again = await exec(["keygen", "--out", key]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("already exists; it is not overwritten");
  });

  it("signs a manifest and verifies it with the public key, and refuses a changed file, the wrong channel, a different kind of document, an untrusted key", async () => {
    const file = path.join(root, "manifest.json");
    writeFileSync(file, JSON.stringify(manifest("stable", 1, "1.5.0")));
    const signed = await exec(["sign", "--kind", "manifest", "--key", key, "--kid", "release-2026", "--in", file]);
    expect(signed.code).toBe(0);
    expect(existsSync(`${file}.sig`)).toBe(true);
    expect(JSON.parse(readFileSync(`${file}.sig`, "utf8"))).toMatchObject({ kid: "release-2026", alg: "Ed25519" });

    const verify = (extra: string[]) => exec(["verify", "--kind", "manifest", "--keys", keys, "--in", file, "--channel", "stable", ...extra]);
    const ok = await verify([]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("OK: stable manifest, sequence 1, 1 release(s)");

    expect((await exec(["verify", "--kind", "manifest", "--keys", keys, "--in", file, "--channel", "beta"])).stderr).toContain("NOT VALID: The manifest is for the \"stable\" channel, not \"beta\"");
    expect((await exec(["verify", "--kind", "config", "--keys", keys, "--in", file])).stderr).toContain("NOT VALID: The signature does not match the document");
    const other = path.join(root, "other-keys.json");
    writeFileSync(other, JSON.stringify({ "release-2026": Buffer.alloc(32, 7).toString("base64") }));
    expect((await exec(["verify", "--kind", "manifest", "--keys", other, "--in", file, "--channel", "stable"])).stderr).toContain("NOT VALID");

    writeFileSync(file, JSON.stringify(manifest("stable", 99, "9.9.9")));
    const tampered = await verify([]);
    expect(tampered.code).toBe(1);
    expect(tampered.stderr).toContain("NOT VALID: The signature does not match the document");
  });

  it("asks for what it needs and says what it does not understand", async () => {
    expect((await exec(["sign", "--kind", "manifest"])).stderr).toContain("--in is required");
    expect((await exec(["sign", "--kind", "manifest", "--in", path.join(root, "manifest.json")])).stderr).toContain("--key is required");
    expect((await exec(["sign", "--kind", "nonsense", "--key", key, "--in", key])).stderr).toContain("--kind must be manifest or config");
    expect((await exec(["publish", "--server", base, "--name", "x", "--in", key])).stderr).toContain("set VIVAH_ADMIN_KEY");
    expect((await exec([])).stderr).toContain("use one of: keygen, sign, verify, publish");
  });

  it("rehearses a whole release: sign, publish to the server, and an app that trusts the key takes the update", async () => {
    const file = path.join(root, "release.json");
    writeFileSync(file, JSON.stringify(manifest("stable", 5, "3.1.0")));
    expect((await exec(["sign", "--kind", "manifest", "--key", key, "--kid", "release-2026", "--in", file])).code).toBe(0);

    const refused = await exec(["publish", "--server", base, "--name", "updates-stable", "--in", file], { VIVAH_ADMIN_KEY: "wrong" });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("the server answered 401");
    const published = await exec(["publish", "--server", base, "--name", "updates-stable", "--in", file], { VIVAH_ADMIN_KEY: ADMIN });
    expect(published.code).toBe(0);
    expect(published.stdout).toContain('Published');

    const lines: string[] = [];
    const home = path.join(root, "app-home");
    const env = { VIVAH_HOME: home, VIVAH_UPDATE_KEYS: keys, VIVAH_UPDATE_URL: base };
    expect(await runCli(["update"], { env, log: (l) => lines.push(l), info: (l) => lines.push(l) })).toBe(0);
    expect(lines.join("\n")).toContain("Version 3.1.0 is available");
    expect(lines.join("\n")).toContain("Download: https://downloads.example/vivah-3.1.0.msi");

    // An app that does not trust this key will not take it.
    const stranger = path.join(root, "stranger.json");
    writeFileSync(stranger, JSON.stringify({ "release-2026": Buffer.alloc(32, 9).toString("base64") }));
    const distrust: string[] = [];
    expect(await runCli(["update"], { env: { VIVAH_HOME: path.join(root, "other-home"), VIVAH_UPDATE_KEYS: stranger, VIVAH_UPDATE_URL: base }, log: (l) => distrust.push(l), info: (l) => distrust.push(l) })).toBe(1);
    expect(distrust.join("\n")).toContain("[SIGNED_DOCUMENT_INVALID] The signature does not match the document");
  });

  it("signs and publishes the remote config the same way, under its own kind", async () => {
    const file = path.join(root, "config.json");
    writeFileSync(file, JSON.stringify({ schema: 1, sequence: 1, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), adapters: { darktable: { stage: "disabled", notice: "Paused for 5.8." } } }));
    expect((await exec(["sign", "--kind", "config", "--key", key, "--kid", "release-2026", "--in", file])).code).toBe(0);
    const ok = await exec(["verify", "--kind", "config", "--keys", keys, "--in", file]);
    expect(ok.stdout).toContain("OK: remote config, sequence 1");
    expect((await exec(["publish", "--server", base, "--name", "config", "--in", file], { VIVAH_ADMIN_KEY: ADMIN })).code).toBe(0);
    // It is signed as a config, so it cannot stand in for a manifest.
    expect((await exec(["verify", "--kind", "manifest", "--keys", keys, "--in", file, "--channel", "stable"])).code).toBe(1);
  });
});
