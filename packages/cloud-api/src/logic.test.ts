import { describe, expect, it } from "vitest";
import { newId, newLicenseKey, newToken, normalizeLicenseKey, safeEqual, sha256Hex } from "./crypto.js";
import { DAY_MS, DEFAULT_ADAPTERS, HOUR_MS, PAST_DUE_GRACE_MS, TOKEN_TTL_MS, entitlementExpiry, isUsable } from "./plans.js";
import { RateLimiter } from "./rateLimit.js";
import type { Subscription } from "./store.js";

describe("license keys and tokens", () => {
  const counter = (() => {
    let i = 0;
    return (n: number) => Buffer.from(Array.from({ length: n }, () => (i++ * 37 + 11) & 255));
  })();

  it("makes keys in the documented shape that survive being typed by a person", () => {
    const key = newLicenseKey(counter);
    expect(key).toMatch(/^VL(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    expect(normalizeLicenseKey(key)).toBe(key);
    expect(normalizeLicenseKey(`  ${key.toLowerCase().replace(/-/g, " - ")} `.replace(/ - /g, "-"))).toBe(key);
    expect(newLicenseKey(counter)).not.toBe(key);
  });

  it("carries 100 bits: all-ones input gives the last symbol, all-zeros the first", () => {
    expect(newLicenseKey(() => Buffer.alloc(13, 0xff))).toBe("VL-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ");
    expect(newLicenseKey(() => Buffer.alloc(13, 0))).toBe("VL-00000-00000-00000-00000");
  });

  it("rejects anything that cannot be a key", () => {
    for (const bad of ["", "VL-12345", "XX-AAAAA-AAAAA-AAAAA-AAAAA", "VL-AAAAA-AAAAA-AAAAA-AAAAI", "VL-AAAAA-AAAAA-AAAAA-AAAAAA", "'; DROP TABLE license; --"]) {
      expect(normalizeLicenseKey(bad)).toBeUndefined();
    }
  });

  it("hashes deterministically, compares in constant time without caring about length, and makes opaque ids and tokens", () => {
    expect(sha256Hex("a")).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
    expect(safeEqual("secret", "secret")).toBe(true);
    expect(safeEqual("secret", "secreT")).toBe(false);
    expect(safeEqual("secret", "secret-longer")).toBe(false);
    expect(newToken(counter)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newId("act", counter)).toMatch(/^act_[A-Za-z0-9_-]{16}$/);
  });
});

describe("subscription rules", () => {
  const T = Date.UTC(2026, 10, 22);
  const sub = (over: Partial<Subscription>): Subscription => ({ accountId: "a", plan: "pro", seats: 1, adapters: DEFAULT_ADAPTERS.pro, status: "active", currentPeriodEnd: null, updatedAt: T, ...over });

  it("treats active and trialing as usable and gives them a full-length token", () => {
    for (const status of ["active", "trialing"] as const) {
      expect(isUsable(sub({ status }), T)).toBe(true);
      expect(entitlementExpiry(sub({ status }), T)).toBe(T + TOKEN_TTL_MS);
    }
  });

  it("caps tokens at the paid period plus grace, but never issues an already-expired token for an active subscription", () => {
    expect(entitlementExpiry(sub({ currentPeriodEnd: T + DAY_MS }), T)).toBe(T + DAY_MS + PAST_DUE_GRACE_MS);
    expect(entitlementExpiry(sub({ currentPeriodEnd: T - 30 * DAY_MS }), T)).toBe(T + HOUR_MS);
  });

  it("keeps a past-due subscription working only through the grace period", () => {
    const s = sub({ status: "past_due", currentPeriodEnd: T });
    expect(isUsable(s, T + PAST_DUE_GRACE_MS)).toBe(true);
    expect(isUsable(s, T + PAST_DUE_GRACE_MS + 1)).toBe(false);
    expect(entitlementExpiry(s, T)).toBe(T + PAST_DUE_GRACE_MS);
    expect(isUsable(sub({ status: "past_due", currentPeriodEnd: null, updatedAt: T }), T + PAST_DUE_GRACE_MS + 1)).toBe(false);
  });

  it("lets a cancelled subscription run to the end of what it paid for, no longer", () => {
    const s = sub({ status: "canceled", currentPeriodEnd: T + 5 * DAY_MS });
    expect(isUsable(s, T + 5 * DAY_MS)).toBe(true);
    expect(isUsable(s, T + 5 * DAY_MS + 1)).toBe(false);
    expect(entitlementExpiry(s, T)).toBe(T + 5 * DAY_MS);
    expect(isUsable(sub({ status: "canceled", currentPeriodEnd: null }), T)).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit per window, reports when to retry, and starts a fresh window afterwards", () => {
    let t = 1_000_000;
    const limiter = new RateLimiter(() => t);
    expect([1, 2, 3].map(() => limiter.hit("k", 3, 60_000).allowed)).toEqual([true, true, true]);
    t += 10_000;
    const blocked = limiter.hit("k", 3, 60_000);
    expect(blocked).toEqual({ allowed: false, retryAfterSec: 50 });
    expect(limiter.hit("other", 3, 60_000).allowed).toBe(true);
    t += 50_000;
    expect(limiter.hit("k", 3, 60_000).allowed).toBe(true);
  });

  it("exhausted() reads without counting", () => {
    const limiter = new RateLimiter(() => 0);
    for (let i = 0; i < 4; i++) expect(limiter.exhausted("f", 5, 60_000).blocked).toBe(false);
    for (let i = 0; i < 5; i++) limiter.hit("f", 5, 60_000);
    expect(limiter.exhausted("f", 5, 60_000).blocked).toBe(true);
  });
});
