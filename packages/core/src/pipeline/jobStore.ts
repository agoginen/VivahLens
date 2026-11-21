import type { EditRecipe } from "../recipe/editRecipe.js";

/** queued → culled | rejected → recipe-generated → review → exported; any stage may end in failed. */
export type ItemState = "queued" | "culled" | "rejected" | "recipe-generated" | "review" | "exported" | "failed";

export interface JobItem {
  jobId: string;
  assetId: string;
  state: ItemState;
  recipe?: EditRecipe;
  rejectReason?: string;
  outputs?: string[];
  exportedFile?: string;
  errorCode?: string;
  errorMessage?: string;
  /** Stage to resume from when a failed item is retried. */
  failedFrom?: ItemState;
  attempts: number;
}

export interface JobMeta {
  id: string;
  name: string;
  adapterId: string;
  styleProfileId: string;
  createdAt: string;
}

export const TERMINAL_STATES: readonly ItemState[] = ["rejected", "exported", "failed"];

/** Persistence seam: single writer, so every item write must be durable before the next stage starts. */
export interface JobStore {
  ensureJob(meta: JobMeta): void;
  getJob(id: string): JobMeta | undefined;
  listItems(jobId: string): JobItem[];
  putItem(item: JobItem): void;
}

export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, JobMeta>();
  private items = new Map<string, JobItem>();

  ensureJob(meta: JobMeta): void {
    if (!this.jobs.has(meta.id)) this.jobs.set(meta.id, meta);
  }
  getJob(id: string): JobMeta | undefined {
    return this.jobs.get(id);
  }
  listItems(jobId: string): JobItem[] {
    return [...this.items.values()].filter((i) => i.jobId === jobId).map((i) => structuredClone(i));
  }
  putItem(item: JobItem): void {
    this.items.set(`${item.jobId}\0${item.assetId}`, structuredClone(item));
  }
}
