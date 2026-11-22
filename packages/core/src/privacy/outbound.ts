/** One transfer of data to a language-model provider. Metadata only: this is the "what leaves your device" ledger (plan §3, §7k). */
export interface OutboundEvent {
  at: string;
  jobId?: string;
  provider: string;
  model?: string;
  purpose: "style-learning" | "recipe" | "narrative" | "embedding" | "conformance" | "other";
  images: number;
  imageBytes: number;
  /** Longest edge of the largest image sent, when known. */
  maxEdgePx?: number;
  /** The photographer chose to send full-resolution images for this job. */
  fullResolution?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /** The request was sent but the provider did not complete it. Whatever it carried still left the device. */
  failed?: boolean;
  /** The provider runs on this computer, so nothing left it. */
  local?: boolean;
}

export interface OutboundTotals {
  calls: number;
  failedCalls: number;
  images: number;
  imageBytes: number;
  inputTokens: number;
  outputTokens: number;
  /** Largest image edge sent, over all calls; undefined when no image sizes are known. */
  maxEdgePx?: number;
  fullResolutionCalls: number;
}

export interface ProviderOutbound extends OutboundTotals {
  provider: string;
  /** How many calls were made for each purpose. */
  purposes: Record<string, number>;
  /** Everything sent to this provider stayed on this computer. */
  local: boolean;
}

const empty = (): OutboundTotals => ({ calls: 0, failedCalls: 0, images: 0, imageBytes: 0, inputTokens: 0, outputTokens: 0, fullResolutionCalls: 0 });

function add(into: OutboundTotals, e: OutboundEvent): void {
  into.calls++;
  if (e.failed) into.failedCalls++;
  into.images += e.images;
  into.imageBytes += e.imageBytes;
  into.inputTokens += e.inputTokens ?? 0;
  into.outputTokens += e.outputTokens ?? 0;
  if (e.fullResolution) into.fullResolutionCalls++;
  if (e.maxEdgePx !== undefined) into.maxEdgePx = Math.max(into.maxEdgePx ?? 0, e.maxEdgePx);
}

/**
 * What has been sent, in total and per provider, for the privacy screen and `vivah privacy`. `totals` counts only what
 * left this computer; what went to a model running locally is listed under its provider but is not "sent".
 */
export function summarizeOutbound(events: readonly OutboundEvent[]): { totals: OutboundTotals; providers: ProviderOutbound[] } {
  const totals = empty();
  const providers = new Map<string, ProviderOutbound>();
  for (const e of events) {
    if (!e.local) add(totals, e);
    const p = providers.get(e.provider) ?? { ...empty(), provider: e.provider, purposes: {}, local: true };
    add(p, e);
    p.purposes[e.purpose] = (p.purposes[e.purpose] ?? 0) + 1;
    if (!e.local) p.local = false;
    providers.set(e.provider, p);
  }
  return { totals, providers: [...providers.values()] };
}
