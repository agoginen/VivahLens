import { VivahError } from "../errors.js";
import { OFFLINE_GRACE_MS, type Entitlement, type EntitlementStatus } from "./entitlement.js";

/**
 * What a command does to the photographer's work. A lapsed license pauses `edit` but never `export`: work that is
 * already done can always be taken out, delivered and undone (plan §7d: "degrades to read-only/export-only, never
 * destroys user work").
 */
export type Operation = "edit" | "export";

export type Access = "full" | "export-only";

/** A verdict from the license server that outranks the token's own expiry: the subscription lapsed, or this device was removed. */
export type Suspension = "subscription" | "device";

export interface VerifiedEntitlement {
  entitlement: Entitlement;
  status: EntitlementStatus;
  suspended?: Suspension;
}

export interface AccessDecision {
  access: Access;
  /** Why editing is paused, when it is. */
  reason?: "expired" | Suspension;
  /** Set while the saved token is past its expiry but inside the offline window: everything works until then, then it needs a reconnect. */
  mustReconnectBy?: number;
}

/**
 * What this license allows right now. The saved token is trusted for its whole offline window, because a photographer
 * at a venue with no signal must not be locked out; a server that says the subscription ended is believed at once.
 */
export function accessFor(verified: VerifiedEntitlement): AccessDecision {
  if (verified.suspended) return { access: "export-only", reason: verified.suspended };
  if (verified.status === "active") return { access: "full" };
  if (verified.status === "grace") return { access: "full", mustReconnectBy: verified.entitlement.expiresAt + OFFLINE_GRACE_MS };
  return { access: "export-only", reason: "expired" };
}

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const STILL_ALLOWED = "You can still export, deliver and undo.";

/**
 * Lets the operation through, or says why not. The adapter has to be in the plan for every operation; editing also
 * needs full access. Returns the decision so callers can show how long an offline license has left.
 */
export function assertAllowed(verified: VerifiedEntitlement, want: { operation: Operation; adapterId?: string }): AccessDecision {
  const { entitlement } = verified;
  if (want.adapterId && !entitlement.adapters.includes(want.adapterId)) {
    throw new VivahError("ENTITLEMENT_INVALID", `Plan "${entitlement.plan}" does not include adapter "${want.adapterId}"`);
  }
  const decision = accessFor(verified);
  if (want.operation === "edit" && decision.access === "export-only") {
    switch (decision.reason) {
      case "subscription":
        throw new VivahError("ENTITLEMENT_EXPIRED", `Your subscription is not active, so editing is paused. ${STILL_ALLOWED} Renew it to keep editing.`);
      case "device":
        throw new VivahError("ENTITLEMENT_INVALID", `This device is no longer activated, so editing is paused. ${STILL_ALLOWED} Run \`vivah activate\` to use this computer again.`);
      default:
        throw new VivahError(
          "ENTITLEMENT_EXPIRED",
          `The saved license ran out on ${date(entitlement.expiresAt)} and could not be renewed, so editing is paused. ${STILL_ALLOWED} Connect to the internet and run \`vivah license\` to renew it.`,
        );
    }
  }
  return decision;
}

/** Refuses a batch bigger than the plan allows (the trial's guided batch). A plan without limits allows anything. */
export function assertWithinLimits(entitlement: Entitlement | undefined, use: { photos: number }): void {
  const max = entitlement?.limits?.maxPhotosPerJob;
  if (max !== undefined && use.photos > max) {
    throw new VivahError("ENTITLEMENT_LIMIT", `The ${entitlement!.plan} plan covers up to ${max} photos per batch and this folder has ${use.photos}. Choose a smaller folder, or subscribe to lift the limit.`);
  }
}
