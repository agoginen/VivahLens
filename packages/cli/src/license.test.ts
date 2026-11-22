import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { signEntitlement } from "@vivahlens/core";
import { describeStatus, requireLicense } from "./license.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
const DAY = 24 * 60 * 60 * 1000;
const token = (over: Partial<Parameters<typeof signEntitlement>[0]> = {}) =>
  signEntitlement(
    { accountId: "a", plan: "pro", seats: 1, adapters: ["xmp-sidecar"], issuedAt: Date.now() - DAY, expiresAt: Date.now() + 5 * DAY, ...over },
    privateKey,
  );
const edit = (adapterId: string) => ({ adapterId, operation: "edit" as const });
const exporting = (adapterId: string) => ({ adapterId, operation: "export" as const });
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const dir = mkdtempSync(path.join(tmpdir(), "vivah-lic-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// Keep these tests away from any real activation in the developer's home directory.
const HOME = { VIVAH_HOME: path.join(dir, "home") };
const withToken = (t: string) => ({ VIVAH_LICENSE_PUBLIC_KEY: pubPem, VIVAH_LICENSE: t, ...HOME });

describe("requireLicense", () => {
  it("is not enforced in a development build with no public key", async () => {
    expect(await requireLicense({}, undefined, edit("xmp-sidecar"))).toMatchObject({ line: expect.stringContaining("not enforced"), access: "full" });
  });

  it("accepts a valid token from a file or the environment when the plan includes the adapter", async () => {
    const file = path.join(dir, "license.txt");
    writeFileSync(file, token());
    expect((await requireLicense({ VIVAH_LICENSE_PUBLIC_KEY: pubPem }, file, edit("xmp-sidecar"))).line).toContain("pro plan");
    const fromEnv = await requireLicense({ VIVAH_LICENSE_PUBLIC_KEY: pubPem, VIVAH_LICENSE: token() }, undefined, edit("xmp-sidecar"));
    expect(fromEnv.line).toContain("valid until");
    expect(fromEnv).toMatchObject({ access: "full", entitlement: { plan: "pro" } });
  });

  it("reads the public key from a file path too", async () => {
    const keyFile = path.join(dir, "pub.pem");
    writeFileSync(keyFile, pubPem);
    expect((await requireLicense({ VIVAH_LICENSE_PUBLIC_KEY: keyFile, VIVAH_LICENSE: token() }, undefined, edit("xmp-sidecar"))).line).toContain("pro plan");
  });

  it("rejects a missing token, a wrong adapter and a forged one, whether editing or exporting", async () => {
    const env = { VIVAH_LICENSE_PUBLIC_KEY: pubPem, ...HOME };
    await expect(requireLicense(env, undefined, edit("xmp-sidecar"))).rejects.toMatchObject({ code: "ENTITLEMENT_INVALID" });
    await expect(requireLicense(withToken(token()), undefined, edit("rawtherapee"))).rejects.toMatchObject({ code: "ENTITLEMENT_INVALID" });
    await expect(requireLicense(withToken(token()), undefined, exporting("rawtherapee"))).rejects.toMatchObject({ code: "ENTITLEMENT_INVALID" });
    const other = generateKeyPairSync("ed25519");
    const forged = signEntitlement({ accountId: "a", plan: "studio", seats: 9, adapters: ["xmp-sidecar"], issuedAt: 0, expiresAt: Date.now() + DAY }, other.privateKey);
    await expect(requireLicense(withToken(forged), undefined, exporting("xmp-sidecar"))).rejects.toMatchObject({ code: "ENTITLEMENT_INVALID" });
  });

  it("keeps working for the 14-day offline window after the token expires, and says until when", async () => {
    const expiresAt = Date.now() - DAY;
    const result = await requireLicense(withToken(token({ expiresAt })), undefined, edit("xmp-sidecar"));
    expect(result).toMatchObject({ access: "full" });
    expect(result.pausedBecause).toBeUndefined();
    expect(result.line).toBe(`License: pro plan. The saved license ran out on ${day(expiresAt)}; it keeps working offline until ${day(expiresAt + 14 * DAY)}. Connect to the internet to renew it.`);
  });

  it("pauses editing once that window has passed, and still lets finished work be exported", async () => {
    const expiresAt = Date.now() - 15 * DAY;
    const env = withToken(token({ expiresAt }));
    await expect(requireLicense(env, undefined, edit("xmp-sidecar"))).rejects.toMatchObject({ code: "ENTITLEMENT_EXPIRED", message: expect.stringContaining("You can still export, deliver and undo.") });
    const exportOnly = await requireLicense(env, undefined, exporting("xmp-sidecar"));
    expect(exportOnly).toMatchObject({ access: "export-only", pausedBecause: "expired" });
    expect(exportOnly.line).toBe(`License: pro plan. Editing is paused: the saved license ran out on ${day(expiresAt)} and could not be renewed. You can still export, deliver and undo.`);
  });
});

describe("describeStatus (vivah license)", () => {
  it("says what works in each state, and how to get back to full", () => {
    expect(describeStatus("active", { access: "full" })).toBe("status: active");
    expect(describeStatus("grace", { access: "full", mustReconnectBy: Date.UTC(2026, 10, 24) })).toBe("status: grace; works offline until 2026-11-24, connect to the internet to renew");
    expect(describeStatus("expired", { access: "export-only", reason: "expired" })).toBe("status: editing paused (expired); you can still export, deliver and undo");
    expect(describeStatus("active", { access: "export-only", reason: "subscription" })).toBe("status: editing paused (subscription inactive); you can still export, deliver and undo");
    expect(describeStatus("active", { access: "export-only", reason: "device" })).toBe("status: editing paused (device removed); you can still export, deliver and undo");
  });
});
