import type { LibraryStore } from "./libraryStore.js";
import type { JobStore } from "./jobStore.js";

export interface ReviewActionDeps {
  store: JobStore;
  /** Where the audit trail goes, when kept. */
  library?: Pick<LibraryStore, "appendAudit">;
  now?: () => Date;
}

export interface ActionResult {
  done: string[];
  skipped: { assetId: string; reason: string }[];
}

const MAX_NOTE_CHARS = 500;

/**
 * Brings photos that the cull rejected (soft, a duplicate, closed eyes, …) back into the job. They join the others at
 * the style stage, so the next run edits them; nothing is sent anywhere by doing this. Photos in any other state are left alone.
 */
export function restoreRejected(deps: ReviewActionDeps, jobId: string, assetIds: readonly string[]): ActionResult {
  const items = new Map(deps.store.listItems(jobId).map((i) => [i.assetId, i]));
  const result: ActionResult = { done: [], skipped: [] };
  for (const assetId of new Set(assetIds)) {
    const item = items.get(assetId);
    if (!item) result.skipped.push({ assetId, reason: "not part of this job" });
    else if (item.state !== "rejected") result.skipped.push({ assetId, reason: `it is ${item.state}, not rejected` });
    else {
      const { rejectReason, ...rest } = item;
      deps.store.putItem({ ...rest, state: "culled", ...(rejectReason && { restoredFrom: rejectReason }) });
      deps.library?.appendAudit({ at: (deps.now?.() ?? new Date()).toISOString(), action: "restore-rejected", jobId, assetId, meta: { was: rejectReason ?? null } });
      result.done.push(assetId);
    }
  }
  return result;
}

/** Marks photos (or clears the mark) for hand retouching in the editor; the list is what the photographer works through afterwards. */
export function setRetouch(deps: ReviewActionDeps, jobId: string, assetIds: readonly string[], on: boolean, note?: string): ActionResult {
  const items = new Map(deps.store.listItems(jobId).map((i) => [i.assetId, i]));
  const result: ActionResult = { done: [], skipped: [] };
  const text = note?.trim().slice(0, MAX_NOTE_CHARS);
  for (const assetId of new Set(assetIds)) {
    const item = items.get(assetId);
    if (!item) {
      result.skipped.push({ assetId, reason: "not part of this job" });
      continue;
    }
    const { retouch: _retouch, retouchNote: _note, ...rest } = item;
    deps.store.putItem({ ...rest, ...(on && { retouch: true, ...(text && { retouchNote: text }) }) });
    deps.library?.appendAudit({ at: (deps.now?.() ?? new Date()).toISOString(), action: on ? "retouch-flag" : "retouch-unflag", jobId, assetId });
    result.done.push(assetId);
  }
  return result;
}

/** The photos flagged for retouching, in job order, with the reviewer's notes. */
export function retouchQueue(store: JobStore, jobId: string): { assetId: string; note?: string; state: string }[] {
  return store
    .listItems(jobId)
    .filter((i) => i.retouch)
    .map((i) => ({ assetId: i.assetId, state: i.state, ...(i.retouchNote && { note: i.retouchNote }) }));
}
