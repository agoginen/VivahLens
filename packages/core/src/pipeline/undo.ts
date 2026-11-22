import { promises as fs } from "node:fs";
import { sha256Hex, writeReplacing } from "../adapters/safeWrite.js";
import type { JobStore } from "./jobStore.js";
import type { LibraryStore, UndoEntry } from "./libraryStore.js";

export interface UndoOptions {
  /** Put files back even when they were changed after VivahLens wrote them. */
  force?: boolean;
  /** Report what would be done and change nothing. */
  dryRun?: boolean;
  /** Only these photos. */
  assetIds?: readonly string[];
}

export interface UndoSummary {
  /** Files put back as they were before the edit. */
  restored: { assetId: string; target: string }[];
  /** Files that did not exist before the edit and were deleted. */
  removed: { assetId: string; target: string }[];
  skipped: { assetId: string; target: string; reason: string }[];
}

/**
 * Takes the edits of a job back out of the files (plan §7g). Each file returns to what it held before the job's first
 * change to it, however many times it was rewritten since (an override re-applies a photo). A file someone edited
 * after VivahLens wrote it is left alone unless `force` is given, so nothing the photographer did afterwards is lost.
 * Photos that were applied but not yet exported go back to "recipe proposed", so a resumed run applies them again.
 */
export async function undoJob(deps: { store: JobStore; library: LibraryStore }, jobId: string, opts: UndoOptions = {}): Promise<UndoSummary> {
  const { store, library } = deps;
  const wanted = opts.assetIds ? new Set(opts.assetIds) : undefined;
  const pending = library.listUndo(jobId, { pending: true }).filter((e) => !wanted || wanted.has(e.assetId));
  const byTarget = new Map<string, UndoEntry[]>();
  for (const entry of pending) byTarget.set(entry.target, [...(byTarget.get(entry.target) ?? []), entry]); // newest first
  const summary: UndoSummary = { restored: [], removed: [], skipped: [] };
  const skippedAssets = new Set<string>();

  for (const [target, entries] of byTarget) {
    const newest = entries[0]!;
    const oldest = entries.at(-1)!;
    const assetId = oldest.assetId;
    const skip = (reason: string) => {
      summary.skipped.push({ assetId, target, reason });
      for (const e of entries) skippedAssets.add(e.assetId);
    };

    const current = await fs.readFile(target).catch(() => undefined);
    if (current && newest.writtenSha256 && sha256Hex(current) !== newest.writtenSha256 && !opts.force) {
      skip("It was changed after VivahLens wrote it (edited in the editor?). Use --force to put the original back anyway.");
      continue;
    }

    if (oldest.backup) {
      const original = await fs.readFile(oldest.backup).catch(() => undefined);
      if (!original) {
        skip(`The backup copy ${oldest.backup} is missing.`);
        continue;
      }
      if (!opts.dryRun) await writeReplacing(target, original);
      summary.restored.push({ assetId, target });
    } else {
      if (!opts.dryRun) await fs.rm(target, { force: true });
      if (current) summary.removed.push({ assetId, target });
    }
    if (!opts.dryRun) for (const e of entries) library.markUndone(e.id!, new Date().toISOString());
  }

  if (!opts.dryRun) {
    const stillPending = new Set(library.listUndo(jobId, { pending: true }).map((e) => e.assetId));
    for (const item of store.listItems(jobId)) {
      const touched = pending.some((e) => e.assetId === item.assetId);
      if (touched && !stillPending.has(item.assetId) && !skippedAssets.has(item.assetId) && ["review", "approved", "applying"].includes(item.state)) {
        store.putItem({ ...item, state: "recipe-generated", outputs: undefined });
      }
    }
    library.appendAudit({ at: new Date().toISOString(), action: "undo", jobId, meta: { restored: summary.restored.length, removed: summary.removed.length, skipped: summary.skipped.length, forced: opts.force === true } });
  }
  return summary;
}
