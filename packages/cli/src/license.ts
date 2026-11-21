import { promises as fs } from "node:fs";
import { assertAdapterAllowed, VivahError, verifyEntitlement } from "@vivahlens/core";

/**
 * Enforces the signed entitlement (plan §7d) when a verification key is configured.
 * With no key configured this is a development build and nothing is enforced; a shipped build embeds the public key,
 * so enforcement there is unconditional. Returns a one-line status for the log.
 */
export async function requireLicense(
  env: Record<string, string | undefined>,
  licenseFile: string | undefined,
  adapterId: string,
): Promise<string> {
  const keySetting = env.VIVAH_LICENSE_PUBLIC_KEY;
  if (!keySetting) return "License: not enforced (development build without an embedded public key).";

  const publicKey = keySetting.includes("BEGIN PUBLIC KEY") ? keySetting : await fs.readFile(keySetting, "utf8");
  const token = (licenseFile ? await fs.readFile(licenseFile, "utf8") : env.VIVAH_LICENSE)?.trim();
  if (!token) throw new VivahError("ENTITLEMENT_INVALID", "No license found. Pass --license <file> or set VIVAH_LICENSE.");

  const result = verifyEntitlement(token, publicKey);
  assertAdapterAllowed(result, adapterId);
  return `License: ${result.entitlement.plan} plan, valid until ${new Date(result.entitlement.expiresAt).toISOString().slice(0, 10)}.`;
}
