import { createHash } from "node:crypto";
import {
  diffOverrides,
  exportApproved,
  learnFromOverrides,
  restoreRejected,
  setRetouch,
  summarizeOutbound,
  unsupportedFields,
  type ActionResult,
  type AssetRef,
  type EditorAdapter,
  type EditRecipe,
  type ExportSpec,
  type ItemState,
  type JobStore,
  type LibraryStore,
  type Logger,
  type Preview,
  type StageDeps,
  type StyleProfile,
} from "@vivahlens/core";

export interface ReviewDeps {
  store: JobStore;
  /** Records reviewer corrections and the audit trail, and supplies the record of what was sent to models, when provided. */
  library?: LibraryStore;
  jobId: string;
  assets: readonly AssetRef[];
  adapter: EditorAdapter;
  profile: StyleProfile;
  /** Smaller previews than the LLM gets are fine here; callers usually pass a ~1024px loader. */
  previewOf(asset: AssetRef): Promise<Preview>;
  /**
   * Draws a recipe onto a photo for the "with the edit" view. Without it the page approximates exposure, contrast and
   * saturation in the browser instead.
   */
  renderPreview?(asset: AssetRef, recipe: EditRecipe): Promise<Preview>;
  /** Required when the adapter can export. */
  exportSpec?: ExportSpec;
  /** Delivery step run on every exported file (see `StageDeps.afterExport`). */
  afterExport?: StageDeps["afterExport"];
  /** Called with the profile after reviewer overrides have nudged it. */
  onProfileUpdated?(profile: StyleProfile): void | Promise<void>;
  /**
   * Set when the license no longer allows editing (the reason is shown in the page, translated). Adjusting a photo is
   * refused; approving, retouch flags and exporting still work, so finished work can always be taken out.
   */
  editingPaused?: "expired" | "subscription" | "device";
  /** Structured log of what the reviewer does (plan §7.6); the decisions are logged by the export step itself. */
  logger?: Logger;
  /**
   * Frees what this job holds (its database, the editor connection). The server calls it when the page moves on to another
   * shoot and when the server stops, so it must be safe to call more than once.
   */
  dispose?(): Promise<void>;
}

export interface Decision {
  approve: string[];
  overrides: Record<string, EditRecipe>;
}

/** Too many drawings are already waiting; the caller should try again in a moment. */
export class RenderQueueFull extends Error {
  constructor() {
    super("too many renders waiting");
    this.name = "RenderQueueFull";
  }
}

const RENDER_CACHE = 48;
const MAX_QUEUED_RENDERS = 8;

const ORDER: Record<ItemState, number> = {
  review: 0,
  failed: 1,
  approved: 2,
  exported: 2,
  delivered: 2,
  rejected: 3,
  queued: 4,
  culled: 4,
  "style-matched": 4,
  "recipe-generated": 4,
  applying: 4,
};

/** One job open in the review page: its photos, the drawings made of them, and what the reviewer decides. */
export class ReviewSession {
  private readonly previews = new Map<string, Promise<Buffer>>();
  private readonly renders = new Map<string, Promise<Buffer>>();
  private readonly assetsById: Map<string, AssetRef>;
  private profile: StyleProfile;
  private queue: Promise<unknown> = Promise.resolve();
  private queuedRenders = 0;
  private renderChain: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(readonly deps: ReviewDeps) {
    this.assetsById = new Map(deps.assets.map((a) => [a.id, a]));
    this.profile = deps.profile;
  }

  get jobId(): string {
    return this.deps.jobId;
  }

  get canRender(): boolean {
    return this.deps.renderPreview !== undefined;
  }

  has(assetId: string): boolean {
    return this.assetsById.has(assetId);
  }

  /** Runs a change to the job's items after the one before it has finished, so two clicks never interleave. */
  serialized<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** The photo's preview, made once. Undefined for a photo that is not in this job. */
  preview(assetId: string): Promise<Buffer> | undefined {
    const asset = this.assetsById.get(assetId);
    if (!asset) return undefined;
    if (!this.previews.has(asset.id)) this.previews.set(asset.id, this.deps.previewOf(asset).then((p) => Buffer.from(p.dataBase64, "base64")));
    return this.previews.get(asset.id)!;
  }

  /** Draws the recipe the reviewer is trying onto the photo. Renders are CPU-bound, so they run one at a time and a pile-up is refused. */
  render(assetId: string, recipe: EditRecipe): Promise<Buffer> {
    const asset = this.assetsById.get(assetId);
    if (!asset || !this.deps.renderPreview) return Promise.reject(new Error("rendering is not available"));
    const key = createHash("sha256").update(assetId).update("\0").update(JSON.stringify(recipe)).digest("hex");
    let bytes = this.renders.get(key);
    if (!bytes) {
      if (this.queuedRenders >= MAX_QUEUED_RENDERS) return Promise.reject(new RenderQueueFull());
      this.queuedRenders++;
      const work = this.renderChain.then(() => this.deps.renderPreview!(asset, recipe)).then((p) => Buffer.from(p.dataBase64, "base64"));
      this.renderChain = work.catch(() => undefined);
      bytes = work.finally(() => void this.queuedRenders--);
      this.renders.set(key, bytes);
      bytes.catch(() => this.renders.delete(key));
      while (this.renders.size > RENDER_CACHE) this.renders.delete(this.renders.keys().next().value!);
    }
    return bytes;
  }

  privacy() {
    if (!this.deps.library) return { available: false };
    return { available: true, job: summarizeOutbound(this.deps.library.listOutbound({ jobId: this.jobId })) };
  }

  listing() {
    const { deps } = this;
    const items = deps.store
      .listItems(this.jobId)
      .sort((a, b) => ORDER[a.state] - ORDER[b.state])
      .map((i) => ({
        id: i.assetId,
        state: i.state,
        recipe: i.recipe,
        unsupported: i.recipe ? unsupportedFields(i.recipe, deps.adapter.capabilities.supportedRecipeFields) : [],
        warnings: i.warnings ?? [],
        rejectReason: i.rejectReason,
        restoredFrom: i.restoredFrom,
        errorMessage: i.errorMessage,
        exportedFile: i.exportedFile,
        outlierFields: i.outlierFields ?? [],
        seenBefore: i.seenBefore,
        sceneId: i.sceneId,
        recipeSource: i.recipeSource,
        retouch: i.retouch === true,
        retouchNote: i.retouchNote,
      }));
    return {
      job: this.jobId,
      adapter: deps.adapter.id,
      rendering: this.canRender,
      editing: deps.editingPaused ? { allowed: false, reason: deps.editingPaused } : { allowed: true },
      profile: { name: this.profile.name, version: this.profile.version },
      ...(deps.exportSpec && deps.adapter.export && { exportDir: deps.exportSpec.outputDir }),
      items,
    };
  }

  async decide(decision: Decision) {
    const { deps } = this;
    const result = await exportApproved(
      { store: deps.store, library: deps.library, adapter: deps.adapter, afterExport: deps.afterExport, ...(deps.logger && { logger: deps.logger }) },
      this.jobId,
      deps.assets,
      { approve: decision.approve, overrides: decision.overrides, exportSpec: deps.exportSpec },
    );
    const overrides = result.overridden.flatMap((o) => (o.original ? diffOverrides(o.original.adjustments, o.final.adjustments) : []));
    if (overrides.length) {
      this.profile = learnFromOverrides(this.profile, overrides);
      await deps.onProfileUpdated?.(this.profile);
    }
    return {
      exported: result.exported.length,
      approved: result.approved.length,
      failed: result.failed.length,
      profileVersion: this.profile.version,
    };
  }

  restore(ids: readonly string[]): Promise<ActionResult> {
    const { deps } = this;
    return this.serialized(() => restoreRejected({ store: deps.store, ...(deps.library && { library: deps.library }) }, this.jobId, ids));
  }

  flag(ids: readonly string[], on: boolean, note?: string): Promise<ActionResult> {
    const { deps } = this;
    return this.serialized(() => setRetouch({ store: deps.store, ...(deps.library && { library: deps.library }) }, this.jobId, ids, on, note));
  }

  /** Frees what the job holds, once. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.deps.dispose?.();
  }
}
