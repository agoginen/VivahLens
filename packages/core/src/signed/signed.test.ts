import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compareSemver, pickRelease, rolloutBucket, verifyManifest, type ReleaseManifest } from "./releaseManifest.js";
import { adapterStatus, verifyRemoteConfig, type RemoteConfig } from "./remoteConfig.js";
import { CONFIG_DOMAIN, MANIFEST_DOMAIN, rawPublicKey, signDocument, verifyDocument } from "./signedDocument.js";

const pair = () => generateKeyPairSync("ed25519");
const K1 = pair();
const K2 = pair();
const pinned = { k1: rawPublicKey(K1.privateKey) };
const NOW = Date.UTC(2026, 10, 22, 12);
const HOUR = 3_600_000;
const bytes = (doc: unknown) => Buffer.from(JSON.stringify(doc));

const artifact = (n: number) => ({ url: `https://downloads.example/v${n}.msi`, sha256: "a".repeat(64), size: 1000 + n });
const release = (version: string, more: Partial<ReleaseManifest["releases"][number]> = {}) => ({
  version,
  status: "active" as const,
  rolloutBp: 10_000,
  notes: `Notes for ${version}`,
  artifacts: { "windows-x86_64": artifact(1), "darwin-aarch64": artifact(2) },
  ...more,
});
const manifest = (more: Partial<ReleaseManifest> = {}): ReleaseManifest => ({
  schema: 1,
  channel: "stable",
  sequence: 5,
  issuedAt: new Date(NOW - HOUR).toISOString(),
  expiresAt: new Date(NOW + 24 * HOUR).toISOString(),
  releases: [release("1.2.0")],
  ...more,
});
const signManifest = (m: unknown, key: KeyObject = K1.privateKey, kid = "k1") => {
  const b = bytes(m);
  return { bytes: b, signature: signDocument(b, { privateKey: key, kid, domain: MANIFEST_DOMAIN }) };
};

describe("signed documents", () => {
  it("accept what a pinned key signed for this kind of document, however the key is written", () => {
    const b = Buffer.from("hello");
    const signature = signDocument(b, { privateKey: K1.privateKey, kid: "k1", domain: "d\n" });
    expect(signature).toMatchObject({ kid: "k1", alg: "Ed25519" });
    expect(Buffer.from(signature.sig, "base64")).toHaveLength(64);
    const raw = rawPublicKey(K1.privateKey);
    for (const key of [raw, Buffer.from(raw, "base64"), new Uint8Array(Buffer.from(raw, "base64")), K1.publicKey, K1.publicKey.export({ type: "spki", format: "pem" }) as string]) {
      expect(() => verifyDocument({ bytes: b, signature, pinned: { k1: key }, domain: "d\n" })).not.toThrow();
    }
  });

  it("reject a changed byte, another kind of document, an untrusted or missing key, and a malformed signature", () => {
    const b = Buffer.from("hello world");
    const good = signDocument(b, { privateKey: K1.privateKey, kid: "k1", domain: MANIFEST_DOMAIN });
    const check = (over: { bytes?: Buffer; signature?: unknown; pinned?: Record<string, string>; domain?: string }) =>
      verifyDocument({ bytes: b, signature: good, pinned, domain: MANIFEST_DOMAIN, ...over });
    expect(() => check({})).not.toThrow();
    expect(() => check({ bytes: Buffer.from("hello worle") })).toThrowError(expect.objectContaining({ code: "SIGNED_DOCUMENT_INVALID", message: "The signature does not match the document" }));
    // A manifest's signature is no use as a remote config's.
    expect(() => check({ domain: CONFIG_DOMAIN })).toThrowError(/does not match/);
    expect(() => check({ signature: { ...good, kid: "k9" } })).toThrowError(/key this app does not trust \(k9\)/);
    expect(() => check({ signature: { ...good, kid: "constructor" } })).toThrowError(/does not trust/);
    expect(() => check({ signature: signDocument(b, { privateKey: K2.privateKey, kid: "k1", domain: MANIFEST_DOMAIN }) })).toThrowError(/does not match/);
    for (const bad of [null, "x", {}, { kid: "k1", alg: "RS256", sig: good.sig }, { kid: "k1", alg: "Ed25519", sig: "AAAA" }, { kid: 1, alg: "Ed25519", sig: good.sig }]) {
      expect(() => check({ signature: bad }), JSON.stringify(bad)).toThrowError(expect.objectContaining({ code: "SIGNED_DOCUMENT_INVALID" }));
    }
    expect(() => check({ pinned: { k1: "AAAA" } })).toThrowError(/32 bytes/);
  });
});

describe("a release manifest", () => {
  it("is accepted when signed by a pinned key, for the channel asked, unexpired and not older than the last, and returns what to remember", () => {
    const { bytes: b, signature } = signManifest(manifest());
    const { manifest: m, state } = verifyManifest({ bytes: b, signature, pinned, expectedChannel: "stable", now: NOW });
    expect(m.releases[0]!.version).toBe("1.2.0");
    expect(state.lastSequence).toBe(5);
    expect(state.lastSha256).toMatch(/^[0-9a-f]{64}$/);
    // The same document again is fine; a newer sequence is fine.
    expect(() => verifyManifest({ bytes: b, signature, pinned, expectedChannel: "stable", now: NOW, state })).not.toThrow();
    const newer = signManifest(manifest({ sequence: 6 }));
    expect(verifyManifest({ ...newer, pinned, expectedChannel: "stable", now: NOW, state }).state.lastSequence).toBe(6);
  });

  it("is refused when tampered with, from an untrusted key, for the wrong channel, expired, or a replay of an older one", () => {
    const run = (over: Partial<Parameters<typeof verifyManifest>[0]>, m: unknown = manifest(), key: KeyObject = K1.privateKey) =>
      verifyManifest({ ...signManifest(m, key), pinned, expectedChannel: "stable", now: NOW, ...over });
    expect(() => run({ bytes: Buffer.from(JSON.stringify(manifest({ sequence: 99 }))) })).toThrowError(/does not match/);
    expect(() => run({}, manifest(), K2.privateKey)).toThrowError(/does not match/);
    expect(() => run({ expectedChannel: "beta" })).toThrowError(/for the "stable" channel, not "beta"/);
    expect(() => run({ now: NOW + 48 * HOUR })).toThrowError(/has expired/);
    expect(() => run({ state: { lastSequence: 6 } })).toThrowError(/older than one already seen/);
    expect(() => run({ state: { lastSequence: 5, lastSha256: "0".repeat(64) } })).toThrowError(/same sequence number/);
  });

  it("is checked for its signature before anything in it is read", () => {
    const garbage = Buffer.from("not json at all {{{");
    const unsigned = { kid: "k1", alg: "Ed25519" as const, sig: Buffer.alloc(64).toString("base64") };
    expect(() => verifyManifest({ bytes: garbage, signature: unsigned, pinned, expectedChannel: "stable", now: NOW })).toThrowError(/does not match/);
    const signedGarbage = { bytes: garbage, signature: signDocument(garbage, { privateKey: K1.privateKey, kid: "k1", domain: MANIFEST_DOMAIN }) };
    expect(() => verifyManifest({ ...signedGarbage, pinned, expectedChannel: "stable", now: NOW })).toThrowError(/not valid JSON/);
  });

  it("must be well formed even when signed: https downloads, real versions, a sha256, a rollout between 0 and 100%", () => {
    const bad = (patch: object) => () => verifyManifest({ ...signManifest({ ...manifest(), ...patch }), pinned, expectedChannel: "stable", now: NOW });
    expect(bad({ releases: [release("1.2.0", { artifacts: { "windows-x86_64": { ...artifact(1), url: "http://downloads.example/x.msi" } } })] })).toThrowError(/not valid/);
    expect(bad({ releases: [release("latest")] })).toThrowError(/not a version/);
    expect(bad({ releases: [release("1.2.0", { rolloutBp: 10_001 })] })).toThrowError(/not valid/);
    expect(bad({ releases: [release("1.2.0", { artifacts: { "windows-x86_64": { ...artifact(1), sha256: "xyz" } } })] })).toThrowError(/not valid/);
    expect(bad({ schema: 2 })).toThrowError(/not valid/);
    expect(bad({ expiresAt: "tomorrow" })).toThrowError(/not valid/);
  });
});

describe("comparing versions", () => {
  it("orders numbers as numbers, and follows the semantic-versioning rules for pre-releases", () => {
    const ordered = ["0.9.9", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.2.3", "1.10.0", "2.0.0"];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) expect(Math.sign(compareSemver(ordered[i]!, ordered[j]!)), `${ordered[i]} vs ${ordered[j]}`).toBe(Math.sign(i - j));
    }
    expect(compareSemver("1.0.0+build.5", "1.0.0+build.9")).toBe(0);
    expect(() => compareSemver("1.0", "1.0.0")).toThrowError(/not a version/);
  });
});

describe("staged rollout", () => {
  it("puts an install at a fixed place for a version, spread evenly, so a growing share never takes the update away", () => {
    expect(rolloutBucket("install-1", "1.2.0")).toBe(rolloutBucket("install-1", "1.2.0"));
    expect(rolloutBucket("install-1", "1.2.0")).not.toBe(rolloutBucket("install-1", "1.2.1"));
    const ids = Array.from({ length: 20_000 }, (_, i) => `install-${i}`);
    const share = (bp: number) => ids.filter((id) => rolloutBucket(id, "1.2.0") < bp);
    expect(share(2500).length / ids.length).toBeGreaterThan(0.24);
    expect(share(2500).length / ids.length).toBeLessThan(0.26);
    const quarter = new Set(share(2500));
    for (const id of share(5000).length ? quarter : []) expect(rolloutBucket(id, "1.2.0")).toBeLessThan(5000);
    expect(share(10_000)).toHaveLength(ids.length);
    expect(share(0)).toHaveLength(0);
  });
});

describe("choosing the release to offer", () => {
  const offer = (m: ReleaseManifest, over: Partial<Parameters<typeof pickRelease>[0]> = {}) => pickRelease({ manifest: m, currentVersion: "1.0.0", installId: "i", target: "windows-x86_64", ...over });

  it("offers the highest active release newer than the one installed, with the artifact for this computer", () => {
    const m = manifest({ releases: [release("1.1.0"), release("1.3.0"), release("1.2.0")] });
    expect(offer(m)).toMatchObject({ kind: "update", release: { version: "1.3.0" }, artifact: { url: "https://downloads.example/v1.msi" } });
    expect(offer(m, { target: "darwin-aarch64" })!.artifact.url).toBe("https://downloads.example/v2.msi");
    expect(offer(m, { currentVersion: "1.3.0" })).toBeUndefined();
    expect(offer(m, { currentVersion: "2.0.0" })).toBeUndefined();
    expect(offer(m, { currentVersion: "1.3.0-rc.1" })).toMatchObject({ release: { version: "1.3.0" } });
  });

  it("skips what is withdrawn, not yet rolled out to this install, built for another system, or out of order", () => {
    const m = manifest({
      releases: [
        release("1.5.0", { status: "withdrawn" }),
        release("1.4.0", { rolloutBp: 0 }),
        release("1.3.0", { artifacts: { "linux-x86_64": artifact(3) } }),
        release("1.2.0", { minFromVersion: "1.1.0" }),
        release("1.1.0"),
      ],
    });
    expect(offer(m)).toMatchObject({ release: { version: "1.1.0" } });
    expect(offer(m, { currentVersion: "1.1.0" })).toMatchObject({ release: { version: "1.2.0" } });
    expect(offer(m, { currentVersion: "1.2.0" })).toBeUndefined();
  });

  it("offers a rollout only to the installs inside its share", () => {
    const m = manifest({ releases: [release("1.2.0", { rolloutBp: 3000 })] });
    const ids = Array.from({ length: 2000 }, (_, i) => `install-${i}`);
    const offered = ids.filter((installId) => offer(m, { installId }));
    expect(offered.length / ids.length).toBeGreaterThan(0.27);
    expect(offered.length / ids.length).toBeLessThan(0.33);
    for (const installId of offered) expect(rolloutBucket(installId, "1.2.0")).toBeLessThan(3000);
  });

  it("moves installs off a withdrawn version back to the good one at once, and leaves everyone else alone", () => {
    const m = manifest({
      releases: [release("1.3.0", { status: "withdrawn", rolloutBp: 0 }), release("1.2.0", { rolloutBp: 0 })],
      rollback: { from: ["1.3.0"], to: "1.2.0" },
    });
    expect(offer(m, { currentVersion: "1.3.0" })).toMatchObject({ kind: "rollback", release: { version: "1.2.0" } });
    expect(offer(m, { currentVersion: "1.1.0" })).toBeUndefined();
    // The version to go back to must itself be active.
    const broken = manifest({ releases: [release("1.3.0", { status: "withdrawn" }), release("1.2.0", { status: "withdrawn" })], rollback: { from: ["1.3.0"], to: "1.2.0" } });
    expect(offer(broken, { currentVersion: "1.3.0" })).toBeUndefined();
  });
});

describe("remote config", () => {
  const config = (more: Partial<RemoteConfig> = {}): RemoteConfig => ({
    schema: 1,
    sequence: 3,
    issuedAt: new Date(NOW - HOUR).toISOString(),
    expiresAt: new Date(NOW + 72 * HOUR).toISOString(),
    prices: { effectiveFrom: "2026-11-01", models: { "gpt-x": { inputPerMTok: 0.5, outputPerMTok: 2 } } },
    adapters: { "lightroom-classic": { stage: "beta", notice: "Beta: tested with Lightroom Classic 14.1." }, rawtherapee: { stage: "disabled", notice: "Paused after RawTherapee 6.0 changed its file format." } },
    ...more,
  });
  const signConfig = (c: unknown, key: KeyObject = K1.privateKey) => {
    const b = bytes(c);
    return { bytes: b, signature: signDocument(b, { privateKey: key, kid: "k1", domain: CONFIG_DOMAIN }) };
  };

  it("is accepted when a pinned key signed it as a config, and is fresh", () => {
    const { config: c, state } = verifyRemoteConfig({ ...signConfig(config()), pinned, now: NOW });
    expect(c.prices!.models["gpt-x"]).toEqual({ inputPerMTok: 0.5, outputPerMTok: 2 });
    expect(state.lastSequence).toBe(3);
    expect(() => verifyRemoteConfig({ ...signConfig(config({ sequence: 2 })), pinned, now: NOW, state })).toThrowError(/older than one already seen/);
    expect(() => verifyRemoteConfig({ ...signConfig(config()), pinned, now: NOW + 100 * HOUR })).toThrowError(/remote config has expired/);
    expect(() => verifyRemoteConfig({ ...signConfig(config()), pinned, now: NOW + 100 * HOUR })).toThrowError(expect.objectContaining({ name: "SignedDocumentExpired", code: "SIGNED_DOCUMENT_INVALID" }));
    // A bad signature is a different kind of failure from an old document.
    expect(() => verifyRemoteConfig({ ...signConfig(config(), K2.privateKey), pinned, now: NOW + 100 * HOUR })).toThrowError(expect.not.objectContaining({ name: "SignedDocumentExpired" }));
    expect(() => verifyRemoteConfig({ ...signConfig(config(), K2.privateKey), pinned, now: NOW })).toThrowError(/does not match/);
  });

  it("cannot be a release manifest's signature replayed, because the signatures are bound to the kind of document", () => {
    const asManifest = signManifest(config());
    expect(() => verifyRemoteConfig({ ...asManifest, pinned, now: NOW })).toThrowError(/does not match/);
    const asConfig = signConfig(manifest());
    expect(() => verifyManifest({ ...asConfig, pinned, expectedChannel: "stable", now: NOW })).toThrowError(/does not match/);
  });

  it("says how each adapter stands, with a notice, and treats one it does not mention as stable", () => {
    const c = config();
    expect(adapterStatus(c, "lightroom-classic")).toEqual({ stage: "beta", notice: "Beta: tested with Lightroom Classic 14.1." });
    expect(adapterStatus(c, "rawtherapee")).toMatchObject({ stage: "disabled" });
    expect(adapterStatus(c, "xmp-sidecar")).toEqual({ stage: "stable" });
    expect(adapterStatus(undefined, "anything")).toEqual({ stage: "stable" });
    expect(adapterStatus(c, "constructor")).toEqual({ stage: "stable" });
    expect(adapterStatus(c, "__proto__")).toEqual({ stage: "stable" });
  });

  it("must be well formed even when signed", () => {
    const bad = (patch: object) => () => verifyRemoteConfig({ ...signConfig({ ...config(), ...patch }), pinned, now: NOW });
    expect(bad({ adapters: { x: { stage: "gone" } } })).toThrowError(/not valid/);
    expect(bad({ prices: { effectiveFrom: "x", models: { m: { inputPerMTok: -1, outputPerMTok: 1 } } } })).toThrowError(/not valid/);
  });
});
