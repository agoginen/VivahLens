import type { EditRecipe } from "../recipe/editRecipe.js";

/**
 * queued → culled | rejected → style-matched → recipe-generated → applying → review → exported | approved → delivered.
 * Any stage may end in failed. `applying` is held only while an adapter is working on the photo, so a crash during an
 * apply is visible on restart and the (repeatable) apply is simply done again.
 */
export type ItemState =
  | "queued"
  | "culled"
  | "rejected"
  | "style-matched"
  | "recipe-generated"
  | "applying"
  | "review"
  | "exported"
  | "approved"
  | "delivered"
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
  /** Reference photos of the learned style that this photo resembles most; shown to the model as examples. */
  styleMatch?: { exemplarIds: string[] };
  /** Where the proposed recipe came from: the model, an earlier reviewer-approved edit, or the recipe cache. */
  recipeSource?: "llm" | "override" | "cache";
  /** Where the delivered file went: a folder, an sftp:// URL or a gallery link. */
  deliveredTo?: string;
  /** Things the editor adapter could not honour but did not treat as errors, shown to the reviewer. */
  warnings?: string[];
  /** The reviewer flagged the photo for hand retouching in the editor (skin, objects, distractions). */
  retouch?: boolean;
  retouchNote?: string;
  /** The reviewer brought the photo back after the cull rejected it; this is why it had been rejected. */
  restoredFrom?: string;
}

export interface JobMeta {
  id: string;
  name: string;
  adapterId: string;
  styleProfileId: string;
  createdAt: string;
}

export const TERMINAL_STATES: readonly ItemState[] = ["rejected", "exported", "approved", "delivered", "failed"];

/** Persistence seam for per-job state: single writer, so every item write must be durable before the next stage starts. */
export interface JobStore {
  ensureJob(meta: JobMeta): void;
  getJob(id: string): JobMeta | undefined;
  listItems(jobId: string): JobItem[];
  putItem(item: JobItem): void;
}
