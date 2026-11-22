import { randomUUID } from "node:crypto";
import type { LicenseStore } from "./licenseClient.js";
import type { SettingsStore } from "./settings.js";

/** Everything a usage report can contain. Counts and cost only (plan §7.6); the server accepts nothing else. */
export interface UsageTotals {
  photos: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type UsageOutcome = "off" | "not-activated" | "sent" | "failed";

export interface UsageReportDeps {
  settings: SettingsStore;
  licenses: LicenseStore;
  usage: UsageTotals;
  fetch?: typeof fetch;
  now?: () => Date;
  newId?: () => string;
  timeoutMs?: number;
}

/** What each field of a report means, for `vivah telemetry`. */
export const USAGE_FIELDS: Record<keyof UsageTotals, string> = {
  photos: "how many photos were in the run",
  llmCalls: "how many requests were made to the model",
  inputTokens: "tokens sent to the model",
  outputTokens: "tokens the model returned",
  costUsd: "what the run cost, from your price table",
};

/**
 * After a run, tells the license server how much work it was, if the person opted in. It is never required: off by
 * default, silent when it cannot reach the server, and never able to fail or slow a run for more than a few seconds.
 */
export async function reportUsage(deps: UsageReportDeps): Promise<UsageOutcome> {
  try {
    if (!(await deps.settings.usageReporting())) return "off";
    const stored = await deps.licenses.readFields();
    if (!stored) return "not-activated";
    const refreshToken = await deps.licenses.readRefreshToken();
    if (!refreshToken) return "not-activated";
    const { photos, llmCalls, inputTokens, outputTokens, costUsd } = deps.usage;
    const res = await (deps.fetch ?? fetch)(new URL("/v1/usage", stored.server), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${refreshToken}` },
      body: JSON.stringify({ events: [{ eventId: (deps.newId ?? randomUUID)(), at: (deps.now?.() ?? new Date()).toISOString(), photos, llmCalls, inputTokens, outputTokens, costUsd: Math.round(costUsd * 1e6) / 1e6 }] }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 4000),
    });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
