import { promises as fs } from "node:fs";
import { assertAllowed, verifyEntitlement, type Access, type AccessDecision, type Entitlement, type EntitlementStatus, type Operation, type Suspension } from "@vivahlens/core";
import { currentEntitlement, LicenseStore } from "./licenseClient.js";

export interface LicenseDeps {
  store?: LicenseStore;
  fetch?: typeof fetch;
  now?: () => number;
}

/** What a command is about to do: the adapter it uses and whether it edits or only takes finished work out. */
export interface LicenseNeed {
  adapterId: string;
  operation: Operation;
}

export interface LicenseOutcome {
  /** One line for the log. */
  line: string;
  access: Access;
  /** Why editing is paused. Only set when `access` is "export-only", for operations that are still let through. */
  pausedBecause?: "expired" | Suspension;
  /** The verified entitlement. Absent in a development build, which enforces nothing. */
  entitlement?: Entitlement;
}

export async function readPublicKey(setting: string): Promise<string> {
  return setting.includes("BEGIN PUBLIC KEY") ? setting : fs.readFile(setting, "utf8");
}

/**
 * Enforces the signed entitlement (plan §7d) when a verification key is configured.
 * A static token (`--license <file>` or VIVAH_LICENSE) is verified offline; otherwise the machine's activation from
 * `vivah activate` is used and refreshed against the license server when it nears expiry.
 * Editing needs full access: a license that ran out and could not be renewed (or that the server says is lapsed)
 * pauses `edit` but still lets `export` through, so finished work can always be taken out.
 * With no key configured this is a development build and nothing is enforced; a shipped build embeds the public key,
 * so enforcement there is unconditional.
 */
export async function requireLicense(
  env: Record<string, string | undefined>,
  licenseFile: string | undefined,
  need: LicenseNeed,
  deps: LicenseDeps = {},
): Promise<LicenseOutcome> {
  const keySetting = env.VIVAH_LICENSE_PUBLIC_KEY;
  if (!keySetting) return { line: "License: not enforced (development build without an embedded public key).", access: "full" };
  const publicKey = await readPublicKey(keySetting);

  const staticToken = (licenseFile ? await fs.readFile(licenseFile, "utf8") : env.VIVAH_LICENSE)?.trim();
  if (staticToken) {
    const verified = verifyEntitlement(staticToken, publicKey, deps.now?.());
    const decision = assertAllowed(verified, need);
    return outcome(verified.entitlement, decision, "");
  }

  const current = await currentEntitlement({ store: deps.store ?? LicenseStore.fromEnv(env), publicKey, fetch: deps.fetch, now: deps.now });
  const decision = assertAllowed(current, need);
  return outcome(current.entitlement, decision, current.refreshed ? " (renewed just now)" : current.offline ? " (offline: using the saved license)" : "");
}

function outcome(entitlement: Entitlement, decision: AccessDecision, note: string): LicenseOutcome {
  return {
    line: `License: ${describeAccess(entitlement, decision, note)}`,
    access: decision.access,
    ...(decision.reason && { pausedBecause: decision.reason }),
    entitlement,
  };
}

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const PAUSED_BECAUSE: Record<NonNullable<AccessDecision["reason"]>, (entitlement: Entitlement) => string> = {
  expired: (e) => `the saved license ran out on ${date(e.expiresAt)} and could not be renewed`,
  subscription: () => "the subscription is not active",
  device: () => "this device is no longer activated",
};

/** How the license stands, in a sentence: valid, working offline until a date, or editing paused. */
export function describeAccess(entitlement: Entitlement, decision: AccessDecision, note = ""): string {
  if (decision.access === "export-only") return `${entitlement.plan} plan. Editing is paused: ${PAUSED_BECAUSE[decision.reason ?? "expired"](entitlement)}. You can still export, deliver and undo.`;
  if (decision.mustReconnectBy) return `${entitlement.plan} plan. The saved license ran out on ${date(entitlement.expiresAt)}; it keeps working offline until ${date(decision.mustReconnectBy)}. Connect to the internet to renew it.`;
  return `${entitlement.plan} plan, valid until ${date(entitlement.expiresAt)}${note}.`;
}

/** One-line summary of what the current license allows, for `vivah license`. */
export function describeEntitlement(entitlement: { plan: string; seats: number; adapters: string[]; expiresAt: number }): string {
  return `${entitlement.plan} plan (${entitlement.seats} seat${entitlement.seats === 1 ? "" : "s"}), adapters: ${entitlement.adapters.join(", ")}, valid until ${date(entitlement.expiresAt)}`;
}

/** The status shown by `vivah license`, with what to do when it is not fully working. */
export function describeStatus(status: EntitlementStatus, decision: AccessDecision): string {
  if (decision.access === "export-only") return `status: editing paused (${decision.reason === "expired" ? "expired" : decision.reason === "subscription" ? "subscription inactive" : "device removed"}); you can still export, deliver and undo`;
  if (decision.mustReconnectBy) return `status: ${status}; works offline until ${date(decision.mustReconnectBy)}, connect to the internet to renew`;
  return `status: ${status}`;
}
