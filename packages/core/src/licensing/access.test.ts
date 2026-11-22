import { describe, expect, it } from "vitest";
import { accessFor, assertAllowed, assertWithinLimits, type VerifiedEntitlement } from "./access.js";
import { OFFLINE_GRACE_MS, type Entitlement } from "./entitlement.js";

const DAY = 24 * 60 * 60 * 1000;
const EXPIRES = Date.UTC(2026, 10, 10);
const entitlement: Entitlement = { accountId: "a", plan: "pro", seats: 1, adapters: ["xmp-sidecar", "video-timeline"], issuedAt: EXPIRES - 7 * DAY, expiresAt: EXPIRES };
const verified = (status: VerifiedEntitlement["status"], more: Partial<VerifiedEntitlement> = {}): VerifiedEntitlement => ({ entitlement, status, ...more });

describe("what a license allows", () => {
  it("is everything while the token is valid, and keeps working offline until the grace window closes", () => {
    expect(accessFor(verified("active"))).toEqual({ access: "full" });
    expect(accessFor(verified("grace"))).toEqual({ access: "full", mustReconnectBy: EXPIRES + OFFLINE_GRACE_MS });
    expect(accessFor(verified("grace")).mustReconnectBy).toBe(Date.UTC(2026, 10, 24));
  });

  it("degrades to export-only once the grace window has passed, saying why", () => {
    expect(accessFor(verified("expired"))).toEqual({ access: "export-only", reason: "expired" });
  });

  it("believes a server verdict over a token that still looks valid", () => {
    expect(accessFor(verified("active", { suspended: "subscription" }))).toEqual({ access: "export-only", reason: "subscription" });
    expect(accessFor(verified("grace", { suspended: "device" }))).toEqual({ access: "export-only", reason: "device" });
  });
});

describe("letting an operation through", () => {
  it("lets editing run while active or inside the grace window, and returns when a reconnect is due", () => {
    expect(assertAllowed(verified("active"), { operation: "edit", adapterId: "xmp-sidecar" })).toEqual({ access: "full" });
    expect(assertAllowed(verified("grace"), { operation: "edit", adapterId: "xmp-sidecar" }).mustReconnectBy).toBe(EXPIRES + OFFLINE_GRACE_MS);
  });

  it("pauses editing but never exporting, whatever the reason, and says what still works", () => {
    const cases: [VerifiedEntitlement, string, RegExp][] = [
      [verified("expired"), "ENTITLEMENT_EXPIRED", /ran out on 2026-11-10 .* run `vivah license` to renew/],
      [verified("active", { suspended: "subscription" }), "ENTITLEMENT_EXPIRED", /subscription is not active, .* Renew it/],
      [verified("active", { suspended: "device" }), "ENTITLEMENT_INVALID", /no longer activated, .* `vivah activate`/],
    ];
    for (const [v, code, message] of cases) {
      expect(() => assertAllowed(v, { operation: "edit", adapterId: "xmp-sidecar" })).toThrowError(expect.objectContaining({ code, message: expect.stringMatching(message) }));
      expect(() => assertAllowed(v, { operation: "edit", adapterId: "xmp-sidecar" })).toThrowError(/You can still export, deliver and undo\./);
      expect(assertAllowed(v, { operation: "export", adapterId: "xmp-sidecar" }).access).toBe("export-only");
    }
  });

  it("still requires the adapter to be in the plan, for exporting as well as editing, even when the license is lapsed", () => {
    for (const status of ["active", "grace", "expired"] as const) {
      for (const operation of ["edit", "export"] as const) {
        expect(() => assertAllowed(verified(status), { operation, adapterId: "rawtherapee" })).toThrowError(
          expect.objectContaining({ code: "ENTITLEMENT_INVALID", message: 'Plan "pro" does not include adapter "rawtherapee"' }),
        );
      }
    }
    // No adapter named: only the access level is checked (for commands that are not tied to an editor).
    expect(() => assertAllowed(verified("active"), { operation: "edit" })).not.toThrow();
  });
});

describe("plan limits", () => {
  const trial: Entitlement = { ...entitlement, plan: "trial", limits: { maxPhotosPerJob: 50 } };

  it("allows a batch up to the limit and refuses the next photo, naming the plan, the limit and the way out", () => {
    expect(() => assertWithinLimits(trial, { photos: 50 })).not.toThrow();
    expect(() => assertWithinLimits(trial, { photos: 51 })).toThrowError(
      expect.objectContaining({ code: "ENTITLEMENT_LIMIT", message: "The trial plan covers up to 50 photos per batch and this folder has 51. Choose a smaller folder, or subscribe to lift the limit." }),
    );
  });

  it("applies no limit to a full plan, or to a build that does not enforce licenses", () => {
    expect(() => assertWithinLimits(entitlement, { photos: 100000 })).not.toThrow();
    expect(() => assertWithinLimits({ ...entitlement, limits: {} }, { photos: 100000 })).not.toThrow();
    expect(() => assertWithinLimits(undefined, { photos: 100000 })).not.toThrow();
  });
});
