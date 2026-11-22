import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { VivahError } from "../errors.js";

const EntitlementSchema = z.object({
  accountId: z.string(),
  plan: z.enum(["trial", "starter", "pro", "studio"]),
  seats: z.number().int().min(1),
  /** Adapter ids the plan unlocks. */
  adapters: z.array(z.string()),
  issuedAt: z.number(),
  /** Unix ms. Tokens are short-lived (≤ 7 days) and refreshed whenever the app is online. */
  expiresAt: z.number(),
  /** Caps that come with the plan, such as the trial's guided batch. Absent on a full plan. */
  limits: z.object({ maxPhotosPerJob: z.number().int().min(1).optional() }).optional(),
});
export type Entitlement = z.infer<typeof EntitlementSchema>;

/**
 * Where a signed token stands against the clock. active: before its expiry. grace: past expiry but inside the offline
 * window, which keeps working while the computer cannot reach the server. expired: beyond that (see `accessFor`).
 */
export type EntitlementStatus = "active" | "grace" | "expired";

export const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

const b64 = (b: Buffer) => b.toString("base64url");

/** Server-side: issue a signed token (ed25519). Exposed here so both sides share one format. */
export function signEntitlement(entitlement: Entitlement, privateKeyPem: string | KeyObject): string {
  const key = typeof privateKeyPem === "string" ? createPrivateKey(privateKeyPem) : privateKeyPem;
  const payload = b64(Buffer.from(JSON.stringify(EntitlementSchema.parse(entitlement))));
  return `${payload}.${b64(sign(null, Buffer.from(payload), key))}`;
}

/** Client-side: verify offline against the embedded public key. */
export function verifyEntitlement(
  token: string,
  publicKeyPem: string | KeyObject,
  now = Date.now(),
): { entitlement: Entitlement; status: EntitlementStatus } {
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length) throw new VivahError("ENTITLEMENT_INVALID", "Malformed entitlement token");
  const key = typeof publicKeyPem === "string" ? createPublicKey(publicKeyPem) : publicKeyPem;
  if (!verify(null, Buffer.from(payload), key, Buffer.from(signature, "base64url"))) {
    throw new VivahError("ENTITLEMENT_INVALID", "Entitlement signature check failed");
  }
  const entitlement = EntitlementSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  const status: EntitlementStatus =
    now < entitlement.expiresAt ? "active" : now < entitlement.expiresAt + OFFLINE_GRACE_MS ? "grace" : "expired";
  return { entitlement, status };
}
