import type { AssetRef } from "../adapters/editorAdapter.js";
import { VivahError } from "../errors.js";
import type { LibraryStore } from "./libraryStore.js";
import { failure, forEachItem, type StageLoopDeps } from "./stage.js";

/** Sends a finished file where the client can get it: a folder, an SFTP server, a gallery. */
export interface Deliverer {
  readonly id: string;
  deliver(file: string, asset: AssetRef, ctx: { jobId: string; signal?: AbortSignal }): Promise<{ destination: string; bytes?: number }>;
}

export interface DeliverySummary {
  delivered: { assetId: string; destination: string }[];
  failed: { assetId: string; code: string; message: string }[];
}

export type DeliverDeps = StageLoopDeps & { library?: LibraryStore };

/**
 * Delivers every exported file that has not been delivered. Only `exported` items move on, so nothing that skipped
 * review or failed finishing can reach a client. A failed delivery keeps its exported file and can be tried again.
 */
export async function deliverExported(deps: DeliverDeps, jobId: string, assets: readonly AssetRef[], deliverer: Deliverer): Promise<DeliverySummary> {
  const { store, library } = deps;
  const byId = new Map(assets.map((a) => [a.id, a]));
  const items = store.listItems(jobId).filter((i) => i.state === "exported" || (i.state === "failed" && i.failedFrom === "exported"));
  const result: DeliverySummary = { delivered: [], failed: [] };

  await forEachItem(deps, "delivered", items.map((i) => (i.state === "failed" ? { ...i, state: "exported" as const } : i)), async (item, asset) => {
    if (!item.exportedFile) throw new VivahError("DELIVERY_FAILED", `${item.assetId} has no exported file to deliver`);
    const to = await deliverer.deliver(item.exportedFile, asset, { jobId, signal: deps.signal }).catch((err: unknown) => {
      if (err instanceof VivahError) throw err;
      throw new VivahError("DELIVERY_FAILED", `Delivering ${item.assetId} through ${deliverer.id} failed: ${err instanceof Error ? err.message : String(err)}`, true);
    });
    store.putItem({ ...item, state: "delivered", deliveredTo: to.destination, errorCode: undefined, errorMessage: undefined, failedFrom: undefined });
    library?.recordDelivery({ jobId, assetId: item.assetId, destination: to.destination, at: new Date().toISOString(), ...(to.bytes !== undefined && { bytes: to.bytes }) });
    result.delivered.push({ assetId: item.assetId, destination: to.destination });
  }, byId);

  result.failed = store
    .listItems(jobId)
    .filter((i) => i.state === "failed" && i.failedFrom === "exported")
    .map(failure);
  library?.appendAudit({ at: new Date().toISOString(), action: "delivered", jobId, meta: { deliverer: deliverer.id, delivered: result.delivered.length, failed: result.failed.length } });
  return result;
}
