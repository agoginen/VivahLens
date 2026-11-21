import type { EditRecipe } from "../recipe/editRecipe.js";

/** queued → culled | rejected → recipe-generated → review → exported | approved; any stage may end in failed. */
export type ItemState =
  | "queued"
  | "culled"
  | "rejected"
  | "recipe-generated"
  | "review"
  | "exported"
  | "approved"
  | "failed";

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
  /** Content fingerprint, used to spot the same file twice. */
  fingerprint?: string;
  /** Id of an earlier job that already processed this exact file. */
  seenBefore?: string;
  /** Scene group (lighting cluster) within the job. */
  sceneId?: number;
  /** Brightness and colour temperature that placed the photo in its scene group. */
  sceneStats?: { meanLuma: number; tempK: number };
  /** Recipe settings that deviate strongly from the rest of the album. */
  outlierFields?: string[];
  /** The reviewer changed the proposed recipe before approving. */
  overridden?: boolean;
}

export interface JobMeta {
  id: string;
  name: string;
  adapterId: string;
  styleProfileId: string;
  createdAt: string;
}

export const TERMINAL_STATES: readonly ItemState[] = ["rejected", "exported", "approved", "failed"];

/** Persistence seam for per-job state: single writer, so every item write must be durable before the next stage starts. */
export interface JobStore {
  ensureJob(meta: JobMeta): void;
  getJob(id: string): JobMeta | undefined;
  listItems(jobId: string): JobItem[];
  putItem(item: JobItem): void;
}
