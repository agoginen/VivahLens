import { z } from "zod";
import { VivahError } from "../errors.js";
import { acceptFresh, CONFIG_DOMAIN, verifyDocument, type PinnedKeys, type SequenceState } from "./signedDocument.js";

const instant = z.string().datetime({ offset: true });

/**
 * Data that changes on someone else's schedule and so must not be baked into a release: what models cost, and which
 * editor adapters are on, in beta, or switched off because an editor update broke them (plan §2.4, §7.6).
 */
export const RemoteConfigSchema = z.object({
  schema: z.literal(1),
  sequence: z.number().int().min(0),
  issuedAt: instant,
  expiresAt: instant,
  prices: z
    .object({
      effectiveFrom: z.string().max(40),
      models: z.record(z.object({ inputPerMTok: z.number().min(0), outputPerMTok: z.number().min(0) })),
    })
    .optional(),
  adapters: z
    .record(
      z.object({
        stage: z.enum(["stable", "beta", "disabled"]),
        /** Shown to the person when the adapter is in beta or switched off. */
        notice: z.string().max(500).optional(),
      }),
    )
    .optional(),
});
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;

const invalid = (message: string) => new VivahError("SIGNED_DOCUMENT_INVALID", message);

/** Accepts a remote config only if a pinned key signed it for this purpose and it is fresh. */
export function verifyRemoteConfig(opts: { bytes: Uint8Array; signature: unknown; pinned: PinnedKeys; state?: SequenceState; now?: number }): { config: RemoteConfig; state: SequenceState } {
  verifyDocument({ bytes: opts.bytes, signature: opts.signature, pinned: opts.pinned, domain: CONFIG_DOMAIN });
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(opts.bytes).toString("utf8"));
  } catch {
    throw invalid("The remote config is not valid JSON");
  }
  const parsed = RemoteConfigSchema.safeParse(json);
  if (!parsed.success) throw invalid(`The remote config is not valid: ${parsed.error.issues[0]?.path.join(".") || "body"}: ${parsed.error.issues[0]?.message}`);
  const state = acceptFresh({ what: "remote config", sequence: parsed.data.sequence, expiresAt: parsed.data.expiresAt, bytes: opts.bytes, state: opts.state, now: opts.now });
  return { config: parsed.data, state };
}

export interface AdapterStatus {
  stage: "stable" | "beta" | "disabled";
  notice?: string;
}

/** How an adapter stands: an adapter the config does not mention is stable. */
export function adapterStatus(config: RemoteConfig | undefined, adapterId: string): AdapterStatus {
  const entry = config?.adapters && Object.hasOwn(config.adapters, adapterId) ? config.adapters[adapterId] : undefined;
  return entry ? { stage: entry.stage, ...(entry.notice !== undefined && { notice: entry.notice }) } : { stage: "stable" };
}
