import { promises as fs } from "node:fs";
import path from "node:path";
import type { AdapterCapabilities, AdapterContext, ApplyResult, AssetRef, EditorAdapter, ExportSpec } from "../adapters/editorAdapter.js";
import { cullBatch, type CullOptions } from "../culling/cull.js";
import type { GrayImage } from "../culling/metrics.js";
import { errorCodeOf, VivahError } from "../errors.js";
import { exportNames } from "../export/names.js";
import type { LlmGateway } from "../llm/gateway.js";
import { recipeHash } from "../recipe/hash.js";
import { EditRecipeSchema, unsupportedFields, type EditRecipe } from "../recipe/editRecipe.js";
import { findOutliers } from "../style/consistency.js";
import type { Logger } from "../observability/logger.js";
import type { StyleRetriever } from "../style/retrieval.js";
import { clusterScenes, type SceneSignature } from "../style/sceneCluster.js";
import { proposeRecipe, type Preview } from "../style/styleEngine.js";
import { diffOverrides, readScalar, type StyleProfile } from "../style/styleProfile.js";
import type { AuditEvent, LibraryStore } from "./libraryStore.js";
import type { ItemState, JobItem, JobStore } from "./jobStore.js";
import { failure, forEachItem, type StageStop } from "./stage.js";

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
  /** Finds reference photos that resemble a photo, to show the model as examples of the look wanted. */
  styleMatch?: StyleRetriever;
  /** How many reference photos to show with each photo (default 2). */
  exampleCount?: number;
  /**
   * Run as far as possible without the model (plan §2.8): recipes already known for a file are reused, and photos
   * that still need the model wait in `style-matched` until a later run is online.
   */
  offline?: boolean;
  cull?: CullOptions;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?(event: { stage: ItemState; done: number; total: number }): void;
  /** Structured log of the run (plan §7.6): metadata only, redacted by the logger. */
  logger?: Logger;
}

/** What stages that don't call the LLM need; keeps export usable without a gateway or profile. */
export type StageDeps = Pick<PipelineDeps, "store" | "library" | "adapter" | "concurrency" | "signal" | "onProgress" | "logger"> & {
  /**
   * Runs on each file the adapter exported, before it counts as exported: watermark, credit, location removal. It
   * receives the requested spec because adapters that cannot resize (`capabilities.exportResize`) export at full
   * resolution and this step has to enforce `spec.maxEdgePx`. If it throws, the item fails with
   * EXPORT_FINISH_FAILED and is not reported as exported; the step should not leave an unfinished file behind.
   */
  afterExport?(file: string, asset: AssetRef, spec: ExportSpec): Promise<void>;
};

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
  /** Photos that still need the model and are waiting for a run with a connection (offline runs). */
  waitingForModel: string[];
  /** What the editor adapter could not do for a photo (a setting it cannot express, a file type it ignores), by photo. */
  warnings: Record<string, string[]>;
  /**
   * The run stopped before every photo was handled because of something no photo could get past (no credit left, a rejected
   * key). Photos not yet started wait where they were; fix the cause and run again to continue.
   */
  stoppedEarly?: { code: string; message: string };
}

const audit = (deps: Pick<StageDeps, "library" | "logger">, event: Omit<AuditEvent, "at">) => {
  deps.library?.appendAudit({ at: new Date().toISOString(), ...event });
  deps.logger?.info(event.action, { ...(event.jobId !== undefined && { jobId: event.jobId }), ...(event.assetId !== undefined && { assetId: event.assetId }), ...event.meta });
};

/**
 * Runs queued → identify → cull → scene → style match → recipe → apply, then stops at the mandatory human review
 * checkpoint. Re-running with the same job id resumes from persisted state; completed work is never redone.
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
  audit(deps, { action: "job-started", jobId: input.id, meta: { photos: input.assets.length, adapter: adapter.id, profile: `${deps.profile.id}@${deps.profile.version}`, offline: deps.offline === true } });

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
  const ctx: AdapterContext = { jobId: input.id, signal: deps.signal };
  const unbind = bindCancel(deps, input.id);
  let stoppedEarly: StageStop | undefined;
  try {
    await identifyStage(deps, input.id, assets, itemsIn("queued"));
    await cullStage(deps, assets, itemsIn("queued"));
    await sceneStage(deps, input.id, assets, itemsIn("culled"));
    await styleMatchStage(deps, assets, itemsIn("culled"));
    await recipeStage(deps, input.id, assets, itemsIn("style-matched")).then((stop) => (stoppedEarly = stop));
    flagOutliers(store, input.id);
    await applyStage(deps, input.id, assets, [...itemsIn("recipe-generated"), ...itemsIn("applying")], ctx).then((stop) => (stoppedEarly ??= stop));
  } finally {
    unbind();
  }

  const summary = { ...summarize(store, input.id, adapter.capabilities), ...(stoppedEarly && { stoppedEarly }) };
  audit(deps, {
    action: "job-ready-for-review",
    jobId: input.id,
    meta: {
      awaitingReview: summary.awaitingReview.length,
      rejected: summary.rejected.length,
      failed: summary.failed.length,
      outliers: Object.keys(summary.outliers).length,
      waitingForModel: summary.waitingForModel.length,
    },
  });
  return summary;
}

/** Cancelling the job (Ctrl-C, the signal) also stops what the adapter has in flight: a started process, queued plugin requests. */
function bindCancel(deps: Pick<StageDeps, "adapter" | "signal">, jobId: string): () => void {
  const { adapter, signal } = deps;
  if (!signal || !adapter.cancel) return () => undefined;
  const onAbort = () => void adapter.cancel!(jobId).catch(() => undefined);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/** Keeps what an adapter replaced so `vivah undo` can put it back. */
function recordReplaced(deps: Pick<StageDeps, "library" | "adapter">, jobId: string, assetId: string, res: ApplyResult): void {
  for (const r of res.replaced ?? []) {
    deps.library?.recordUndo({
      jobId,
      assetId,
      adapterId: deps.adapter.id,
      target: r.target,
      ...(r.backup && { backup: r.backup }),
      ...(r.writtenSha256 && { writtenSha256: r.writtenSha256 }),
      at: new Date().toISOString(),
    });
  }
}

/** Looks up the reference photos nearest to each kept photo. A failure here never fails a photo: examples are an optimisation. */
async function styleMatchStage(deps: PipelineDeps, assets: Map<string, AssetRef>, culled: JobItem[]): Promise<void> {
  const { styleMatch, store } = deps;
  if (culled.length === 0) return;
  await forEachItem(deps, "style-matched", culled, async (item, asset) => {
    let exemplarIds: string[] = [];
    if (styleMatch) exemplarIds = await styleMatch.nearest(asset, deps.exampleCount ?? 2).catch(() => []);
    store.putItem({ ...item, state: "style-matched", ...(exemplarIds.length > 0 && { styleMatch: { exemplarIds } }) });
  }, assets);
}

/** One recipe per photo: reused when the file's recipe is already known, otherwise asked of the model (unless offline). */
async function recipeStage(deps: PipelineDeps, jobId: string, assets: Map<string, AssetRef>, items: JobItem[]): Promise<StageStop | undefined> {
  const { store, library, profile } = deps;
  if (items.length === 0) return undefined;
  const sceneTotal = new Set(store.listItems(jobId).filter((i) => i.sceneId !== undefined).map((i) => i.sceneId)).size;
  return forEachItem(deps, "recipe-generated", items, async (item, asset) => {
    const known = item.fingerprint ? library?.findRecipe(item.fingerprint, profile.id, profile.version) : undefined;
    if (known) {
      store.putItem({ ...item, state: "recipe-generated", recipe: known.recipe, recipeSource: known.source === "override" ? "override" : "cache" });
      return { source: known.source === "override" ? "override" : "cache", recipeHash: known.hash };
    }
    if (deps.offline) return; // waits in `style-matched` for a run that can reach the model

    const scene =
      item.sceneId !== undefined && item.sceneStats
        ? { index: item.sceneId + 1, total: sceneTotal, ...item.sceneStats }
        : undefined;
    const examples = item.styleMatch && deps.styleMatch ? await deps.styleMatch.exemplars(item.styleMatch.exemplarIds).catch(() => []) : [];
    const recipe = EditRecipeSchema.parse(await proposeRecipe(deps.gateway, { preview: await deps.previewOf(asset), profile, scene, examples }));
    store.putItem({ ...item, state: "recipe-generated", recipe, recipeSource: "llm" });
    const hash = recipeHash(recipe);
    if (item.fingerprint) {
      library?.putRecipe({
        hash,
        fingerprint: item.fingerprint,
        profileId: profile.id,
        profileVersion: profile.version,
        recipe,
        source: "llm",
        ...(recipe.confidence !== undefined && { confidence: recipe.confidence }),
        jobId,
        assetId: item.assetId,
        createdAt: new Date().toISOString(),
      });
    }
    return { source: "llm", recipeHash: hash, ...(recipe.confidence !== undefined && { confidence: recipe.confidence }) };
  }, assets);
}

/**
 * Lets the editor know about the files, then applies each recipe, keeping what was replaced so the apply can be undone.
 * Returns why it stopped early when something no other photo could get past happened (an unsupported editor version).
 */
async function applyStage(deps: PipelineDeps, jobId: string, assets: Map<string, AssetRef>, items: JobItem[], ctx: AdapterContext): Promise<StageStop | undefined> {
  const { store, adapter, library } = deps;
  let todo = items;
  if (adapter.importAssets && todo.length > 0) {
    try {
      const wanted = todo.flatMap((i) => assets.get(i.assetId) ?? []);
      const { skipped } = await adapter.importAssets(wanted, ctx);
      const refused = new Map(skipped.map((s) => [s.assetId, s.reason]));
      for (const item of todo) {
        const reason = refused.get(item.assetId);
        if (reason !== undefined) {
          store.putItem({ ...item, state: "failed", failedFrom: item.state, attempts: item.attempts + 1, errorCode: "ASSET_UNREADABLE", errorMessage: `${adapter.id} could not import ${item.assetId}: ${reason}` });
        }
      }
      todo = todo.filter((i) => !refused.has(i.assetId));
    } catch (err) {
      for (const item of todo) {
        store.putItem({ ...item, state: "failed", failedFrom: item.state, attempts: item.attempts + 1, errorCode: errorCodeOf(err), errorMessage: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
  }
  return forEachItem(deps, "review", todo, async (item, asset) => {
    if (!item.recipe) throw new VivahError("ADAPTER_APPLY_FAILED", "Item has no recipe to apply");
    store.putItem({ ...item, state: "applying" });
    const res = await adapter.applyRecipe(asset, item.recipe, ctx);
    recordReplaced(deps, jobId, item.assetId, res);
    store.putItem({ ...item, state: "review", outputs: res.outputs, warnings: res.warnings?.length ? res.warnings : undefined });
    return { adapter: adapter.id, recipeHash: recipeHash(item.recipe), warnings: res.warnings?.length ?? 0, replaced: res.replaced?.length ?? 0 };
  }, assets);
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

/** The spec as an adapter that cannot resize should receive it: full resolution. */
function withoutSize({ maxEdgePx: _ignored, ...rest }: ExportSpec): ExportSpec {
  return rest;
}

/** Two spellings of one path are the same file on Windows and macOS when they differ only in case. */
const sameFileKey = (file: string) => (process.platform === "win32" || process.platform === "darwin" ? path.resolve(file).toLowerCase() : path.resolve(file));

/** Exports only items that are in review AND explicitly approved: nothing client-facing ships unreviewed. */
export async function exportApproved(
  deps: StageDeps,
  jobId: string,
  assets: readonly AssetRef[],
  decision: ReviewDecision,
): Promise<ExportSummary> {
  const { store, adapter, library } = deps;
  const exportFn = adapter.export?.bind(adapter);
  const spec = decision.exportSpec;
  if (exportFn && !spec) {
    throw new VivahError("ADAPTER_APPLY_FAILED", `Adapter "${adapter.id}" needs an export spec`);
  }
  // Adapters that cannot resize export at full resolution; the delivery step then enforces the size.
  const adapterResizes = adapter.capabilities.exportResize === true;
  if (exportFn && spec?.maxEdgePx !== undefined && !adapterResizes && !deps.afterExport) {
    throw new VivahError("ADAPTER_APPLY_FAILED", `Adapter "${adapter.id}" cannot resize on export and no delivery step was given to do it`);
  }
  const adapterSpec = spec && !adapterResizes ? withoutSize(spec) : spec;
  const names = exportNames(assets);
  const writers = new Map<string, { file: string; ids: string[] }>();
  const approved = new Set(decision.approve);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const items = store.listItems(jobId).filter((i) => i.state === "review" && approved.has(i.assetId));
  const result: ExportSummary = { exported: [], approved: [], failed: [], overridden: [] };
  const ctx: AdapterContext = { jobId, signal: deps.signal };
  const unbind = bindCancel(deps, jobId);

  try {
    await forEachItem(deps, "exported", items, async (item, asset) => {
      let current = item;
      const override = decision.overrides?.[item.assetId];
      if (override) {
        const valid = EditRecipeSchema.parse(override);
        recordReplaced(deps, jobId, item.assetId, await adapter.applyRecipe(asset, valid, ctx));
        result.overridden.push({ assetId: item.assetId, original: item.recipe, final: valid });
        current = { ...item, recipe: valid, overridden: true, recipeSource: "override" };
        if (library) {
          const at = new Date().toISOString();
          if (item.recipe) {
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
          // The reviewer's version is what any later run on this exact file should start from.
          const profileId = store.getJob(jobId)?.styleProfileId;
          if (item.fingerprint && profileId) {
            library.putRecipe({
              hash: recipeHash(valid),
              fingerprint: item.fingerprint,
              profileId,
              profileVersion: library.loadProfile(profileId)?.version ?? 0,
              recipe: valid,
              source: "override",
              jobId,
              assetId: item.assetId,
              createdAt: at,
            });
          }
        }
      }
      if (!exportFn) {
        // Edit-only adapters (e.g. XMP sidecars): the photographer exports from their own editor.
        store.putItem({ ...current, state: "approved" });
        result.approved.push(item.assetId);
        return { adapter: adapter.id, overridden: override !== undefined, outcome: "approved" };
      }
      const out = await exportFn(asset, { ...adapterSpec!, fileName: names.get(asset.id) }, ctx);
      const key = sameFileKey(out.file);
      const writer = writers.get(key) ?? { file: out.file, ids: [] };
      writer.ids.push(item.assetId);
      writers.set(key, writer);
      if (deps.afterExport) {
        await deps.afterExport(out.file, asset, spec!).catch((err: unknown) => {
          throw new VivahError("EXPORT_FINISH_FAILED", `${path.basename(out.file)} was exported but could not be finished: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      store.putItem({ ...current, state: "exported", exportedFile: out.file });
      result.exported.push({ assetId: item.assetId, file: out.file });
      return { adapter: adapter.id, overridden: override !== undefined, outcome: "exported", file: out.file };
    }, byId);
  } finally {
    unbind();
  }

  await failSharedFiles(deps, jobId, writers, result);

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

/**
 * An adapter that ignores `fileName` can write one file for several photos. That file then holds only one of them,
 * and may not have been finished, so it is deleted and every photo that wrote it fails: an unfinished export is never
 * left in the delivery folder, and nothing is reported as exported that is not what it says.
 */
async function failSharedFiles(
  deps: Pick<StageDeps, "store" | "adapter">,
  jobId: string,
  writers: Map<string, { file: string; ids: string[] }>,
  result: ExportSummary,
): Promise<void> {
  const shared = [...writers.values()].filter((w) => w.ids.length > 1);
  if (shared.length === 0) return;
  const items = new Map(deps.store.listItems(jobId).map((i) => [i.assetId, i]));
  for (const { file, ids } of shared) {
    const removed = await fs.rm(file, { force: true }).then(() => true, () => false);
    const message =
      `Adapter "${deps.adapter.id}" wrote the same file, ${path.basename(file)}, for ${ids.join(" and ")}, so none of them can be delivered. ` +
      (removed ? "The file was removed; export them again." : `The file could not be removed: delete ${file} yourself before delivering, it holds only one of them.`);
    for (const id of ids) {
      const item = items.get(id);
      if (item) {
        deps.store.putItem({ ...item, state: "failed", failedFrom: "review", attempts: item.attempts + 1, errorCode: "ADAPTER_APPLY_FAILED", errorMessage: message, exportedFile: undefined });
      }
    }
    result.exported = result.exported.filter((e) => !ids.includes(e.assetId));
  }
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
  const items = store.listItems(jobId).filter((i) => i.recipe && ["recipe-generated", "applying", "review", "approved", "exported", "delivered"].includes(i.state));
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

function summarize(store: JobStore, jobId: string, caps: AdapterCapabilities): ReviewSummary {
  const items = store.listItems(jobId);
  const unsupported: Record<string, string[]> = {};
  const outliers: Record<string, string[]> = {};
  const seenBefore: Record<string, string> = {};
  const rejectReasons: Record<string, string> = {};
  const warnings: Record<string, string[]> = {};
  for (const i of items) {
    if (i.state === "review" && i.recipe) {
      const fields = unsupportedFields(i.recipe, caps.supportedRecipeFields);
      if (fields.length) unsupported[i.assetId] = fields;
    }
    if (i.warnings?.length && i.state === "review") warnings[i.assetId] = i.warnings;
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
    waitingForModel: items.filter((i) => i.state === "style-matched").map((i) => i.assetId),
    warnings,
  };
}
