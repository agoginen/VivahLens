import type { AdapterCapabilities, AssetRef, EditorAdapter, ExportSpec } from "../adapters/editorAdapter.js";
import { cullBatch, type CullOptions } from "../culling/cull.js";
import type { GrayImage } from "../culling/metrics.js";
import { errorCodeOf, VivahError } from "../errors.js";
import type { LlmGateway } from "../llm/gateway.js";
import { EditRecipeSchema, unsupportedFields, type EditRecipe } from "../recipe/editRecipe.js";
import { proposeRecipe, type Preview } from "../style/styleEngine.js";
import type { StyleProfile } from "../style/styleProfile.js";
import type { ItemState, JobItem, JobStore } from "./jobStore.js";

export interface PipelineDeps {
  store: JobStore;
  gateway: LlmGateway;
  adapter: EditorAdapter;
  profile: StyleProfile;
  /** Preview-resolution image sent to the LLM; originals never leave the machine. */
  previewOf(asset: AssetRef): Promise<Preview>;
  /** Small grayscale decode for culling; when omitted, culling is skipped. */
  grayOf?(asset: AssetRef): Promise<GrayImage>;
  cull?: CullOptions;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?(event: { stage: ItemState; done: number; total: number }): void;
}

/** What stages that don't call the LLM need; keeps export usable without a gateway or profile. */
export type StageDeps = Pick<PipelineDeps, "store" | "adapter" | "concurrency" | "signal" | "onProgress">;

export interface JobInput {
  id: string;
  name: string;
  assets: readonly AssetRef[];
  /** Retry items that failed in an earlier run, from the stage where they failed. */
  retryFailed?: boolean;
}

export interface ReviewSummary {
  jobId: string;
  /** Items applied and waiting for a human decision. */
  awaitingReview: string[];
  rejected: string[];
  failed: { assetId: string; code: string; message: string }[];
  /** Recipe fields the adapter ignores, so the UI can warn before export. */
  unsupported: Record<string, string[]>;
}

/**
 * Runs queued → cull → recipe → apply, then stops at the mandatory human review checkpoint.
 * Re-running with the same job id resumes from persisted state; completed work is never redone.
 * One item's failure never aborts the batch.
 */
export async function runJob(deps: PipelineDeps, input: JobInput): Promise<ReviewSummary> {
  const { store, adapter } = deps;
  store.ensureJob({
    id: input.id,
    name: input.name,
    adapterId: adapter.id,
    styleProfileId: deps.profile.id,
    createdAt: new Date().toISOString(),
  });

  const known = new Map(store.listItems(input.id).map((i) => [i.assetId, i]));
  for (const asset of input.assets) {
    if (!known.has(asset.id)) store.putItem({ jobId: input.id, assetId: asset.id, state: "queued", attempts: 0 });
  }
  if (input.retryFailed) {
    for (const item of store.listItems(input.id)) {
      if (item.state === "failed" && item.failedFrom) {
        store.putItem({ ...item, state: item.failedFrom, failedFrom: undefined, errorCode: undefined, errorMessage: undefined });
      }
    }
  }

  const assets = new Map(input.assets.map((a) => [a.id, a]));
  const itemsIn = (state: ItemState) => store.listItems(input.id).filter((i) => i.state === state);

  await cullStage(deps, assets, itemsIn("queued"));
  await forEachItem(deps, "recipe-generated", itemsIn("culled"), async (item, asset) => {
    const recipe = await proposeRecipe(deps.gateway, { preview: await deps.previewOf(asset), profile: deps.profile });
    store.putItem({ ...item, state: "recipe-generated", recipe: EditRecipeSchema.parse(recipe) });
  }, assets);
  await forEachItem(deps, "review", itemsIn("recipe-generated"), async (item, asset) => {
    if (!item.recipe) throw new VivahError("ADAPTER_APPLY_FAILED", "Item has no recipe to apply");
    const res = await adapter.applyRecipe(asset, item.recipe);
    store.putItem({ ...item, state: "review", outputs: res.outputs });
  }, assets);

  return summarize(store, input.id, adapter.capabilities);
}

export interface ReviewDecision {
  /** Asset ids the photographer approved for export. Everything else stays in review. */
  approve: readonly string[];
  /** Replacement recipes from the review UI's per-photo sliders; re-applied before export. */
  overrides?: Readonly<Record<string, EditRecipe>>;
  exportSpec: ExportSpec;
}

export interface ExportSummary {
  exported: { assetId: string; file: string }[];
  failed: { assetId: string; code: string; message: string }[];
  /** Overridden recipes, to feed back into the style profile. */
  overridden: { assetId: string; original?: EditRecipe; final: EditRecipe }[];
}

/** Exports only items that are in review AND explicitly approved: nothing client-facing ships unreviewed. */
export async function exportApproved(
  deps: StageDeps,
  jobId: string,
  assets: readonly AssetRef[],
  decision: ReviewDecision,
): Promise<ExportSummary> {
  const { store, adapter } = deps;
  if (!adapter.export) throw new VivahError("ADAPTER_APPLY_FAILED", `Adapter "${adapter.id}" cannot export`);
  const exportFn = adapter.export.bind(adapter);
  const approved = new Set(decision.approve);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const items = store.listItems(jobId).filter((i) => i.state === "review" && approved.has(i.assetId));
  const result: ExportSummary = { exported: [], failed: [], overridden: [] };

  await forEachItem(deps, "exported", items, async (item, asset) => {
    let current = item;
    const override = decision.overrides?.[item.assetId];
    if (override) {
      const valid = EditRecipeSchema.parse(override);
      await adapter.applyRecipe(asset, valid);
      result.overridden.push({ assetId: item.assetId, original: item.recipe, final: valid });
      current = { ...item, recipe: valid };
    }
    const out = await exportFn(asset, decision.exportSpec);
    store.putItem({ ...current, state: "exported", exportedFile: out.file });
    result.exported.push({ assetId: item.assetId, file: out.file });
  }, byId);

  result.failed = store
    .listItems(jobId)
    .filter((i) => i.state === "failed" && i.failedFrom === "review")
    .map(failure);
  return result;
}

async function cullStage(deps: PipelineDeps, assets: Map<string, AssetRef>, queued: JobItem[]): Promise<void> {
  const { store, grayOf } = deps;
  if (queued.length === 0) return;
  if (!grayOf) {
    for (const item of queued) store.putItem({ ...item, state: "culled" });
    return;
  }

  const decoded: { id: string; image: GrayImage }[] = [];
  await forEachItem(deps, "culled", queued, async (item, asset) => {
    decoded.push({ id: item.assetId, image: await grayOf(asset) });
  }, assets);

  const result = cullBatch(decoded, deps.cull);
  const byId = new Map(queued.map((i) => [i.assetId, i]));
  for (const id of result.kept) store.putItem({ ...byId.get(id)!, state: "culled" });
  for (const r of result.rejected) {
    store.putItem({ ...byId.get(r.id)!, state: "rejected", rejectReason: r.reason });
  }
}

/** Runs fn over items with bounded concurrency; failures are recorded per item and never thrown. */
async function forEachItem(
  deps: StageDeps,
  stage: ItemState,
  items: JobItem[],
  fn: (item: JobItem, asset: AssetRef) => Promise<void>,
  assets: Map<string, AssetRef>,
): Promise<void> {
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      deps.signal?.throwIfAborted();
      const item = items[next++]!;
      const asset = assets.get(item.assetId);
      try {
        if (!asset) throw new VivahError("ASSET_UNREADABLE", `Asset ${item.assetId} was not provided`);
        await fn(item, asset);
      } catch (err) {
        deps.store.putItem({
          ...item,
          state: "failed",
          failedFrom: item.state,
          attempts: item.attempts + 1,
          errorCode: errorCodeOf(err),
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      deps.onProgress?.({ stage, done: ++done, total: items.length });
    }
  };
  const n = Math.max(1, Math.min(deps.concurrency ?? 4, items.length));
  await Promise.all(Array.from({ length: n }, worker));
}

const failure = (i: JobItem) => ({
  assetId: i.assetId,
  code: i.errorCode ?? "UNKNOWN",
  message: i.errorMessage ?? "",
});

function summarize(store: JobStore, jobId: string, caps: AdapterCapabilities): ReviewSummary {
  const items = store.listItems(jobId);
  const unsupported: Record<string, string[]> = {};
  for (const i of items) {
    if (i.state === "review" && i.recipe) {
      const fields = unsupportedFields(i.recipe, caps.supportedRecipeFields);
      if (fields.length) unsupported[i.assetId] = fields;
    }
  }
  return {
    jobId,
    awaitingReview: items.filter((i) => i.state === "review").map((i) => i.assetId),
    rejected: items.filter((i) => i.state === "rejected").map((i) => i.assetId),
    failed: items.filter((i) => i.state === "failed").map(failure),
    unsupported,
  };
}
