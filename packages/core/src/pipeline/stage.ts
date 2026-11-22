import type { AssetRef } from "../adapters/editorAdapter.js";
import { BATCH_FATAL, errorCodeOf, VivahError } from "../errors.js";
import type { Logger, LogFields } from "../observability/logger.js";
import type { ItemState, JobItem, JobStore } from "./jobStore.js";

export interface StageLoopDeps {
  store: JobStore;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?(event: { stage: ItemState; done: number; total: number }): void;
  /** One record per photo per stage: job, photo, stage, how long it took and how it ended (plan §7.6). */
  logger?: Logger;
}

/** Why a stage stopped taking new photos before it ran out of them. */
export interface StageStop {
  code: string;
  message: string;
}

/**
 * Runs fn over items with bounded concurrency; failures are recorded per item and never thrown. A failure that every other
 * photo would hit too (no credit left, a rejected key) stops the stage from starting more of them, and is returned: the
 * photos not yet started stay where they were, ready to continue once the cause is fixed.
 * What `fn` returns (the adapter used, the recipe's hash) is added to the photo's log record.
 */
export async function forEachItem(
  deps: StageLoopDeps,
  stage: ItemState,
  items: JobItem[],
  fn: (item: JobItem, asset: AssetRef) => Promise<void | LogFields>,
  assets: Map<string, AssetRef>,
): Promise<StageStop | undefined> {
  let next = 0;
  let done = 0;
  let stop: StageStop | undefined;
  const worker = async () => {
    while (next < items.length && !stop) {
      deps.signal?.throwIfAborted();
      const item = items[next++]!;
      const asset = assets.get(item.assetId);
      const started = performance.now();
      const took = () => Math.round(performance.now() - started);
      try {
        if (!asset) throw new VivahError("ASSET_UNREADABLE", `Asset ${item.assetId} was not provided`);
        const extra = await fn(item, asset);
        deps.logger?.info("item.done", { jobId: item.jobId, assetId: item.assetId, stage, durationMs: took(), ...(extra ?? {}) });
      } catch (err) {
        const code = errorCodeOf(err);
        const message = err instanceof Error ? err.message : String(err);
        deps.store.putItem({ ...item, state: "failed", failedFrom: item.state, attempts: item.attempts + 1, errorCode: code, errorMessage: message });
        deps.logger?.warn("item.failed", { jobId: item.jobId, assetId: item.assetId, stage, durationMs: took(), code, message, attempts: item.attempts + 1 });
        if (BATCH_FATAL.has(code)) stop ??= { code, message };
      }
      deps.onProgress?.({ stage, done: ++done, total: items.length });
    }
  };
  const n = Math.max(1, Math.min(deps.concurrency ?? 4, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return stop;
}

export const failure = (i: JobItem) => ({
  assetId: i.assetId,
  code: i.errorCode ?? "UNKNOWN",
  message: i.errorMessage ?? "",
});
