import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OFFLINE_GRACE_MS, signEntitlement, verifyEntitlement } from "./entitlement.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const DAY = 24 * 60 * 60 * 1000;
const base = { accountId: "a1", plan: "pro" as const, seats: 2, adapters: ["xmp-sidecar"], issuedAt: 0, expiresAt: 7 * DAY };

describe("entitlements", () => {
  const token = signEntitlement(base, privateKey);

  it("verifies offline and reports active, grace, then expired", () => {
    expect(verifyEntitlement(token, publicKey, DAY).status).toBe("active");
    expect(verifyEntitlement(token, publicKey, 8 * DAY).status).toBe("grace");
    expect(verifyEntitlement(token, publicKey, base.expiresAt + OFFLINE_GRACE_MS + 1).status).toBe("expired");
  });

  it("rejects a tampered payload", () => {
    const [, sig] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...base, plan: "studio" })).toString("base64url")}.${sig}`;
    expect(() => verifyEntitlement(forged, publicKey)).toThrowError(expect.objectContaining({ code: "ENTITLEMENT_INVALID" }));
  });

  it("carries plan limits inside the signed payload, so they cannot be edited out", () => {
    const limited = signEntitlement({ ...base, plan: "trial", limits: { maxPhotosPerJob: 50 } }, privateKey);
    expect(verifyEntitlement(limited, publicKey, DAY).entitlement.limits).toEqual({ maxPhotosPerJob: 50 });
    expect(verifyEntitlement(token, publicKey, DAY).entitlement.limits).toBeUndefined();
    const [, sig] = limited.split(".");
    const stripped = `${Buffer.from(JSON.stringify({ ...base, plan: "trial" })).toString("base64url")}.${sig}`;
    expect(() => verifyEntitlement(stripped, publicKey, DAY)).toThrowError(expect.objectContaining({ code: "ENTITLEMENT_INVALID" }));
    expect(() => signEntitlement({ ...base, limits: { maxPhotosPerJob: 0 } }, privateKey)).toThrow();
  });
});
