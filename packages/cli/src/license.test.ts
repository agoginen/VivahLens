import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { signEntitlement } from "@vivahlens/core";
import { requireLicense } from "./license.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
const DAY = 24 * 60 * 60 * 1000;
const token = (over: Partial<Parameters<typeof signEntitlement>[0]> = {}) =>
  signEntitlement(
    { accountId: "a", plan: "pro", seats: 1, adapters: ["xmp-sidecar"], issuedAt: Date.now() - DAY, expiresAt: Date.now() + 5 * DAY, ...over },
    privateKey,
  );

const dir = mkdtempSync(path.join(tmpdir(), "vivah-lic-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("requireLicense", () => {
  it("is not enforced in a development build with no public key", async () => {
    expect(await requireLicense({}, undefined, "xmp-sidecar")).toContain("not enforced");
  });

  it("accepts a valid token from a file or the environment when the plan includes the adapter", async () => {
    const file = path.join(dir, "license.txt");
    writeFileSync(file, token());
    expect(await requireLicense({ VIVAH_LICENSE_PUBLIC_KEY: pubPem }, file, "xmp-sidecar")).toContain("pro plan");
    expect(await requireLicense({ VIVAH_LICENSE_PUBLIC_KEY: pubPem, VIVAH_LICENSE: token() }, undefined, "xmp-sidecar")).toContain("valid until");
  });

  it("reads the public key from a file path too", async () => {
    const keyFile = path.join(dir, "pub.pem");
    writeFileSync(keyFile, pubPem);
    expect(await requireLicense({ VIVAH_LICENSE_PUBLIC_KEY: keyFile, VIVAH_LICENSE: token() }, undefined, "xmp-sidecar")).toContain("pro plan");
  });

  it("rejects a missing token, a wrong adapter, an expired token and a forged one", async () => {
    const env = { VIVAH_LICENSE_PUBLIC_KEY: pubPem };
    await expect(requireLicense(env, undefined, "xmp-sidecar")).rejects.toMatchObject({ code: "ENTITLEMENT_INVALID" });
    await expect(requireLicense({ ...env, VIVAH_LICENSE: token() }, undefined, "rawtherapee")).rejects.toMatchObject({ code: "ENTITLEMENT_INVALID" });
    await expect(requireLicense({ ...env, VIVAH_LICENSE: token({ expiresAt: Date.now() - DAY }) }, undefined, "xmp-sidecar")).rejects.toMatchObject({ code: "ENTITLEMENT_EXPIRED" });
    const other = generateKeyPairSync("ed25519");
    const forged = signEntitlement({ accountId: "a", plan: "studio", seats: 9, adapters: ["xmp-sidecar"], issuedAt: 0, expiresAt: Date.now() + DAY }, other.privateKey);
    await expect(requireLicense({ ...env, VIVAH_LICENSE: forged }, undefined, "xmp-sidecar")).rejects.toMatchObject({ code: "ENTITLEMENT_INVALID" });
  });
});
