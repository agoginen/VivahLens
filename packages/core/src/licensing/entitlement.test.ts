import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertAdapterAllowed, OFFLINE_GRACE_MS, signEntitlement, verifyEntitlement } from "./entitlement.js";

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

  it("only allows adapters in the plan while active", () => {
    const active = verifyEntitlement(token, publicKey, DAY);
    expect(() => assertAdapterAllowed(active, "xmp-sidecar")).not.toThrow();
    expect(() => assertAdapterAllowed(active, "rawtherapee")).toThrowError(expect.objectContaining({ code: "ENTITLEMENT_INVALID" }));
    expect(() => assertAdapterAllowed(verifyEntitlement(token, publicKey, 8 * DAY), "xmp-sidecar")).toThrowError(
      expect.objectContaining({ code: "ENTITLEMENT_EXPIRED" }),
    );
  });
});
