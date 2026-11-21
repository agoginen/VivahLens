import type { AdapterCapabilities, AssetRef, EditorAdapter, ExportSpec } from "../adapters/editorAdapter.js";
import { cullBatch, type CullOptions } from "../culling/cull.js";
import type { GrayImage } from "../culling/metrics.js";
import { errorCodeOf, VivahError } from "../errors.js";
import type { LlmGateway } from "../llm/gateway.js";
import { EditRecipeSchema, unsupportedFields, type EditRecipe } from "../recipe/editRecipe.js";
import { findOutliers } from "../style/consistency.js";
import { clusterScenes, type SceneSignature } from "../style/sceneCluster.js";
import { proposeRecipe, type Preview } from "../style/styleEngine.js";
import { diffOverrides, readScalar, type StyleProfile } from "../style/styleProfile.js";
import type { AuditEvent, LibraryStore } from "./libraryStore.js";
import type { ItemState, JobItem, JobStore } from "./jobStore.js";

export interface PipelineDeps {
  store: JobStore;
  /** Cross-job library (assets, overrides, profile versions, audit). Optional so tests and tiny runs stay simple. */
  library?: LibraryStore;
  gateway: LlmGateway;
  adapter: EditorAdapter;
  profile: StyleProfile;
  /** Preview-resolution image sent to the LLM; originals never leave the machine. */
  previewOf(asset: AssetRef): Promise<Preview>;
  /** Small grayscale decode for culling; when omitted, culling is skipped. */
  grayOf?(asset: AssetRef): Promise<GrayImage>;
  /** Mean brightness and colour temperature, to group scenes and give the LLM per-scene context. */
  sceneOf?(asset: AssetRef): Promise<{ meanLuma: number; tempK: number }>;
  /** Content fingerprint + EXIF, to skip duplicate files and remember what was seen. */
  describe?(asset: AssetRef): Promise<{ fingerprint: string; exif?: Record<string, unknown> }>;
  cull?: CullOptions;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?(event: { stage: ItemState; done: number; total: number }): void;
}

/** What stages that don't call the LLM need; keeps export usable without a gateway or profile. */
export type StageDeps = Pick<PipelineDeps, "store" | "library" | "adapter" | "concurrency" | "signal" | "onProgress">;

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
  /** Why each rejected item was dropped ("blurry", "duplicate", "duplicate-file"). */
  rejectReasons: Record<string, string>;
  failed: { assetId: string; code: string; message: string }[];
  /** Recipe fields the adapter ignores, so the UI can warn before export. */
  unsupported: Record<string, string[]>;
  /** Recipe settings that differ strongly from the rest of the album; flagged, never silently changed. */
  outliers: Record<string, string[]>;
  /** Files that an earlier job already processed, with that job's id. */
  seenBefore: Record<string, string>;
}

const audit = (deps: Pick<StageDeps, "library">, event: Omit<AuditEvent, "at">) =>
  deps.library?.appendAudit({ at: new Date().toISOString(), ...event });

/**
 * Runs queued → identify → cull → scene → recipe → apply, then stops at the mandatory human review checkpoint.
 * Re-running with the same job id resumes from persisted state; completed work is never redone.
 * One item's failure never aborts the batch.
 */
export async function runJob(deps: PipelineDeps, input: JobInput): Promise<ReviewSummary> {
  const { store, adapter, library } = deps;
  store.ensureJob({
    id: input.id,
    name: input.name,
    adapterId: adapter.id,
    styleProfileId: deps.profile.id,
    createdAt: new Date().toISOString(),
  });
  library?.saveProfile(deps.profile);
  audit(deps, { action: "job-started", jobId: input.id, meta: { photos: input.assets.length, adapter: adapter.id, profile: `${deps.profile.id}@${deps.profile.version}` } });

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

  await identifyStage(deps, input.id, assets, itemsIn("queued"));
  await cullStage(deps, assets, itemsIn("queued"));
  await sceneStage(deps, input.id, assets, itemsIn("culled"));

  const sceneTotal = new Set(store.listItems(input.id).filter((i) => i.sceneId !== undefined).map((i) => i.sceneId)).size;
  await forEachItem(deps, "recipe-generated", itemsIn("culled"), async (item, asset) => {
    const scene =
      item.sceneId !== undefined && item.sceneStats
        ? { index: item.sceneId + 1, total: sceneTotal, ...item.sceneStats }
        : undefined;
    const recipe = await proposeRecipe(deps.gateway, { preview: await deps.previewOf(asset), profile: deps.profile, scene });
    store.putItem({ ...item, state: "recipe-generated", recipe: EditRecipeSchema.parse(recipe) });
  }, assets);

  flagOutliers(store, input.id);

  await forEachItem(deps, "review", itemsIn("recipe-generated"), async (item, asset) => {
    if (!item.recipe) throw new VivahError("ADAPTER_APPLY_FAILED", "Item has no recipe to apply");
    const res = await adapter.applyRecipe(asset, item.recipe);
    store.putItem({ ...item, state: "review", outputs: res.outputs });
  }, assets);

  const summary = summarize(store, input.id, adapter.capabilities);
  audit(deps, {
    action: "job-ready-for-review",
    jobId: input.id,
    meta: { awaitingReview: summary.awaitingReview.length, rejected: summary.rejected.length, failed: summary.failed.length, outliers: Object.keys(summary.outliers).length },
  });
  return summary;
}

export interface ReviewDecision {
  /** Asset ids the photographer approved for export. Everything else stays in review. */
  approve: readonly string[];
  /** Replacement recipes from the review UI's per-photo sliders; re-applied before export. */
  overrides?: Readonly<Record<string, EditRecipe>>;
  /** Required when the adapter can export; ignored by edit-only adapters. */
  exportSpec?: ExportSpec;
}

export interface ExportSummary {
  exported: { assetId: string; file: string }[];
  /** Approved on an edit-only adapter; the photographer exports from their own editor. */
  approved: string[];
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
  const { store, adapter, library } = deps;
  const exportFn = adapter.export?.bind(adapter);
  if (exportFn && !decision.exportSpec) {
    throw new VivahError("ADAPTER_APPLY_FAILED", `Adapter "${adapter.id}" needs an export spec`);
  }
  const approved = new Set(decision.approve);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const items = store.listItems(jobId).filter((i) => i.state === "review" && approved.has(i.assetId));
  const result: ExportSummary = { exported: [], approved: [], failed: [], overridden: [] };

  await forEachItem(deps, "exported", items, async (item, asset) => {
    let current = item;
    const override = decision.overrides?.[item.assetId];
    if (override) {
      const valid = EditRecipeSchema.parse(override);
      await adapter.applyRecipe(asset, valid);
      result.overridden.push({ assetId: item.assetId, original: item.recipe, final: valid });
      current = { ...item, recipe: valid, overridden: true };
      if (item.recipe && library) {
        const at = new Date().toISOString();
        library.recordOverrides(
          diffOverrides(item.recipe.adjustments, valid.adjustments).map((o) => ({
            jobId,
            assetId: item.assetId,
            path: o.path,
            oldValue: readScalar(item.recipe!.adjustments, o.path),
            newValue: o.value,
            at,
          })),
        );
      }
    }
    if (!exportFn) {
      // Edit-only adapters (e.g. XMP sidecars): the photographer exports from their own editor.
      store.putItem({ ...current, state: "approved" });
      result.approved.push(item.assetId);
      return;
    }
    const out = await exportFn(asset, decision.exportSpec!);
    store.putItem({ ...current, state: "exported", exportedFile: out.file });
    result.exported.push({ assetId: item.assetId, file: out.file });
  }, byId);

  result.failed = store
    .listItems(jobId)
    .filter((i) => i.state === "failed" && i.failedFrom === "review")
    .map(failure);
  audit(deps, {
    action: "review-decision",
    jobId,
    meta: { approved: result.approved.length, exported: result.exported.length, overridden: result.overridden.length, failed: result.failed.length },
  });
  return result;
}

/** Fingerprints files so the same file is processed once, and remembers every file the app has seen. */
async function identifyStage(deps: PipelineDeps, jobId: string, assets: Map<string, AssetRef>, queued: JobItem[]): Promise<void> {
  const { describe, store, library } = deps;
  if (!describe || queued.length === 0) return;

  const described = new Map<string, { fingerprint: string; exif?: Record<string, unknown> }>();
  await forEachItem(deps, "queued", queued, async (item, asset) => {
    described.set(item.assetId, await describe(asset));
  }, assets);

  const seen = new Map<string, string>();
  for (const i of store.listItems(jobId)) if (i.fingerprint && i.state !== "rejected") seen.set(i.fingerprint, i.assetId);

  for (const item of queued) {
    const d = described.get(item.assetId);
    if (!d) continue;
    const first = seen.get(d.fingerprint);
    if (first !== undefined && first !== item.assetId) {
      store.putItem({ ...item, fingerprint: d.fingerprint, state: "rejected", rejectReason: "duplicate-file" });
      continue;
    }
    seen.set(d.fingerprint, item.assetId);
    const prior = library?.findAssetsByFingerprint(d.fingerprint).find((a) => a.firstSeenJob !== jobId);
    library?.putAsset({
      path: assets.get(item.assetId)!.path,
      fingerprint: d.fingerprint,
      exif: d.exif,
      firstSeenJob: jobId,
      firstSeenAt: new Date().toISOString(),
    });
    store.putItem({ ...item, fingerprint: d.fingerprint, ...(prior && { seenBefore: prior.firstSeenJob }) });
  }
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

/** Groups kept photos by lighting so indoor and outdoor frames get scene-aware recipes. Failures here never fail a photo. */
async function sceneStage(deps: PipelineDeps, jobId: string, assets: Map<string, AssetRef>, culled: JobItem[]): Promise<void> {
  const { sceneOf, store } = deps;
  const pending = culled.filter((i) => i.sceneId === undefined);
  if (!sceneOf || pending.length === 0) return;

  const stats = new Map<string, { meanLuma: number; tempK: number }>();
  await forEachItem(deps, "culled", pending, async (item, asset) => {
    try {
      stats.set(item.assetId, await sceneOf(asset));
    } catch {
      // Scene context is an optimisation; the photo proceeds without it.
    }
  }, assets);

  const signatures: SceneSignature[] = pending.flatMap((i) => {
    const s = stats.get(i.assetId);
    return s ? [{ id: i.assetId, ...s }] : [];
  });
  const offset = Math.max(-1, ...store.listItems(jobId).map((i) => i.sceneId ?? -1)) + 1;
  const byId = new Map(pending.map((i) => [i.assetId, i]));
  clusterScenes(signatures).forEach((ids, index) => {
    for (const id of ids) {
      const item = byId.get(id)!;
      store.putItem({ ...item, sceneId: offset + index, sceneStats: stats.get(id) });
    }
  });
}

/** Marks recipes that deviate from the album so the reviewer looks at them; never rewrites them. */
function flagOutliers(store: JobStore, jobId: string): void {
  const items = store.listItems(jobId).filter((i) => i.recipe && ["recipe-generated", "review", "approved", "exported"].includes(i.state));
  const flagged = new Map<string, string[]>();
  for (const o of findOutliers(items.map((i) => ({ id: i.assetId, recipe: i.recipe! })))) {
    flagged.set(o.id, [...(flagged.get(o.id) ?? []), o.path]);
  }
  for (const item of items) {
    const fields = flagged.get(item.assetId);
    if (JSON.stringify(fields) !== JSON.stringify(item.outlierFields)) {
      store.putItem({ ...item, ...(fields ? { outlierFields: fields } : { outlierFields: undefined }) });
    }
  }
}

/** Runs fn over items with bounded concurrency; failures are recorded per item and never thrown. */
async function forEachItem(
  deps: Pick<StageDeps, "store" | "concurrency" | "signal" | "onProgress">,
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
  const outliers: Record<string, string[]> = {};
  const seenBefore: Record<string, string> = {};
  const rejectReasons: Record<string, string> = {};
  for (const i of items) {
    if (i.state === "review" && i.recipe) {
      const fields = unsupportedFields(i.recipe, caps.supportedRecipeFields);
      if (fields.length) unsupported[i.assetId] = fields;
    }
    if (i.outlierFields?.length && i.state === "review") outliers[i.assetId] = i.outlierFields;
    if (i.seenBefore) seenBefore[i.assetId] = i.seenBefore;
    if (i.state === "rejected" && i.rejectReason) rejectReasons[i.assetId] = i.rejectReason;
  }
  return {
    jobId,
    awaitingReview: items.filter((i) => i.state === "review").map((i) => i.assetId),
    rejected: items.filter((i) => i.state === "rejected").map((i) => i.assetId),
    rejectReasons,
    failed: items.filter((i) => i.state === "failed").map(failure),
    unsupported,
    outliers,
    seenBefore,
  };
}
