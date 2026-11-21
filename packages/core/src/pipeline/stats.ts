import type { JobStore } from "./jobStore.js";
import type { LibraryStore } from "./libraryStore.js";

export interface JobStats {
  jobId: string;
  total: number;
  rejected: { blurry: number; duplicate: number; duplicateFile: number };
  failed: number;
  awaitingReview: number;
  /** Photos the reviewer approved (exported or approved), changed or not. */
  approved: number;
  approvedUnchanged: number;
  overridden: number;
  /** Approved without any manual correction / approved. The plan's Phase 0 target is ≥ 0.7. Undefined until something is approved. */
  acceptanceRate?: number;
  outliers: number;
  /** How often each setting was corrected by the reviewer. */
  correctionsByField: Record<string, number>;
}

/** Metrics that answer "do photographers accept what the AI proposes?" from persisted job state. */
export function jobStats(store: JobStore, jobId: string, library?: LibraryStore): JobStats {
  const items = store.listItems(jobId);
  const approvedItems = items.filter((i) => i.state === "approved" || i.state === "exported");
  const overridden = approvedItems.filter((i) => i.overridden).length;
  const correctionsByField: Record<string, number> = {};
  for (const o of library?.listOverrides(jobId) ?? []) correctionsByField[o.path] = (correctionsByField[o.path] ?? 0) + 1;

  const reason = (r: string) => items.filter((i) => i.state === "rejected" && i.rejectReason === r).length;
  return {
    jobId,
    total: items.length,
    rejected: { blurry: reason("blurry"), duplicate: reason("duplicate"), duplicateFile: reason("duplicate-file") },
    failed: items.filter((i) => i.state === "failed").length,
    awaitingReview: items.filter((i) => i.state === "review").length,
    approved: approvedItems.length,
    approvedUnchanged: approvedItems.length - overridden,
    overridden,
    acceptanceRate: approvedItems.length ? (approvedItems.length - overridden) / approvedItems.length : undefined,
    outliers: items.filter((i) => i.outlierFields?.length).length,
    correctionsByField,
  };
}
