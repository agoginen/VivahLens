import type { Plan, Subscription } from "./store.js";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** Entitlement tokens are short-lived and refreshed whenever the app is online. */
export const TOKEN_TTL_MS = 7 * DAY_MS;
/** How long a lapsed payment keeps working, so a slow card retry does not lock a photographer out mid-wedding. */
export const PAST_DUE_GRACE_MS = 3 * DAY_MS;

export const DEFAULT_ADAPTERS: Record<Plan, string[]> = {
  trial: ["xmp-sidecar", "builtin-render"],
  starter: ["xmp-sidecar", "builtin-render"],
  pro: ["xmp-sidecar", "rawtherapee", "darktable", "lightroom-classic", "builtin-render", "video-timeline"],
  studio: ["xmp-sidecar", "rawtherapee", "darktable", "lightroom-classic", "builtin-render", "video-timeline"],
};

/** The trial is one guided batch (plan §7d), so its tokens cap the photos in a job. Paid plans have no photo cap (plan §5). */
export const TRIAL_MAX_PHOTOS = 50;

/** The caps that go into a plan's entitlement tokens, or undefined for a plan without any. */
export function limitsFor(plan: Plan): { maxPhotosPerJob: number } | undefined {
  return plan === "trial" ? { maxPhotosPerJob: TRIAL_MAX_PHOTOS } : undefined;
}

/** Whether the subscription currently entitles the customer to use the product. */
export function isUsable(sub: Subscription, now: number): boolean {
  switch (sub.status) {
    case "active":
    case "trialing":
      return true;
    case "past_due":
      return now <= (sub.currentPeriodEnd ?? sub.updatedAt) + PAST_DUE_GRACE_MS;
    case "paused":
    case "canceled":
      // Paid-through: a cancelled or paused subscription works until the period it already paid for ends.
      return sub.currentPeriodEnd !== null && now <= sub.currentPeriodEnd;
  }
}

/** When a token issued now should stop being valid. Never later than the paid period (plus grace) allows. */
export function entitlementExpiry(sub: Subscription, now: number): number {
  const cap = now + TOKEN_TTL_MS;
  const end = sub.currentPeriodEnd;
  switch (sub.status) {
    case "active":
    case "trialing":
      // Status is authoritative; a stale period end must not issue an already-expired token.
      return end === null ? cap : Math.max(Math.min(cap, end + PAST_DUE_GRACE_MS), now + HOUR_MS);
    case "past_due":
      return Math.min(cap, (end ?? sub.updatedAt) + PAST_DUE_GRACE_MS);
    case "paused":
    case "canceled":
      return Math.min(cap, end ?? now);
  }
}
