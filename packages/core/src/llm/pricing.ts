import type { LlmUsage } from "./types.js";

export interface ModelPrice {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

export interface VersionedPriceTable {
  /** ISO date the prices take effect; prices change on provider schedules, so this is remote-configurable data. */
  effectiveFrom: string;
  models: Record<string, ModelPrice>;
}

/** Cost in USD, or undefined when the model has no known price (local models are free by convention). */
export function costOf(table: VersionedPriceTable, model: string, usage: LlmUsage): number | undefined {
  const price = table.models[model];
  if (!price) return undefined;
  return (
    ((usage.inputTokens ?? 0) * price.inputPerMTok + (usage.outputTokens ?? 0) * price.outputPerMTok) / 1_000_000
  );
}

/** Pre-run estimate for a batch, surfaced to the user before spending anything. */
export function estimateBatchCost(
  table: VersionedPriceTable,
  model: string,
  items: number,
  perItem: { inputTokens: number; outputTokens: number },
): number | undefined {
  const per = costOf(table, model, perItem);
  return per === undefined ? undefined : per * items;
}
