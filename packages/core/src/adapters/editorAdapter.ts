import type { EditRecipe } from "../recipe/editRecipe.js";

export type MediaKind = "photo" | "video";
export type ExecutionModel = "local-plugin" | "local-cli" | "cloud-headless";

export interface AssetRef {
  id: string;
  kind: MediaKind;
  path: string;
}

export interface AdapterCapabilities {
  mediaKinds: readonly MediaKind[];
  executionModel: ExecutionModel;
  requiresGuiOpen: boolean;
  os: readonly ("windows" | "macos")[];
  /** Top-level EditRecipe adjustment keys this adapter honors. */
  supportedRecipeFields: readonly string[];
  /**
   * `export` honours `ExportSpec.maxEdgePx`. When false or absent the adapter exports at full resolution and a
   * delivery step (`afterExport`) has to enforce the size.
   */
  exportResize?: boolean;
  /** Runs with no window and no logged-in editor: a command-line tool the agent can start itself (cloud workers need this). */
  headless?: boolean;
  /** Only exchanges files with the editor (XMP sidecars, FCPXML): it never learns whether the editor applied them. */
  fileDrivenOnly?: boolean;
}

export interface InstalledEditorInfo {
  version?: string;
  path?: string;
}

/** What the pipeline tells an adapter about the work it is part of. */
export interface AdapterContext {
  jobId?: string;
  /** Aborts when the photographer cancels; adapters stop launching and kill what they started. */
  signal?: AbortSignal;
}

export interface ImportResult {
  imported: string[];
  /** Files the editor refused, with why (unreadable, unsupported format, not in a watched folder). */
  skipped: { assetId: string; reason: string }[];
}

/** Live progress an adapter reports about its own work (a plugin applying settings, a CLI exporting). */
export interface ProgressEvent {
  jobId?: string;
  assetId?: string;
  stage: string;
  done: number;
  total: number;
  message?: string;
}

/** What an adapter would hand to its editor for a recipe, without doing it: a dry run that shows what will and will not be honoured. */
export interface NativeEditPayload {
  /** Format of the payload: "xmp", "pp3", "develop-settings", … */
  kind: string;
  payload: string | Record<string, unknown>;
  /** Recipe fields this editor ignores. */
  unsupported: string[];
  warnings?: string[];
}

export interface ApplyResult {
  assetId: string;
  /** Files written or modified by the adapter (sidecars, profiles, timelines). */
  outputs: string[];
  /** Things the adapter could not honor but did not treat as errors. */
  warnings?: string[];
  /**
   * What each written file held before (a copy kept next to the job's data, or none when the file is new), so the
   * apply can be undone (plan §7g). Adapters that overwrite files report this; the pipeline records it.
   * `writtenSha256` lets an undo refuse to clobber a file that was edited again afterwards.
   */
  replaced?: { target: string; backup?: string; writtenSha256?: string }[];
}

export interface ExportSpec {
  format: "jpeg" | "tiff";
  /** Long edge in pixels; omitted = full resolution. */
  maxEdgePx?: number;
  quality?: number;
  outputDir: string;
  /**
   * File name to give this export, without extension. The pipeline sets it so that photos sharing a name (a RAW and
   * its camera JPEG) never write to the same file. Adapters that export must honour it.
   */
  fileName?: string;
}

export interface ExportResult {
  assetId: string;
  file: string;
}

/**
 * The seam between the orchestrator and an editing tool. Everything tool-specific
 * (native recipe translation, process launching, file layout) hides behind these methods.
 */
export interface EditorAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
  /** Null when the editor is not installed or not usable on this machine. */
  detect(): Promise<InstalledEditorInfo | null>;
  /** Makes the editor aware of the files before edits are applied (Lightroom: add them to the catalog). Optional. */
  importAssets?(assets: readonly AssetRef[], ctx?: AdapterContext): Promise<ImportResult>;
  applyRecipe(asset: AssetRef, recipe: EditRecipe, ctx?: AdapterContext): Promise<ApplyResult>;
  export?(asset: AssetRef, spec: ExportSpec, ctx?: AdapterContext): Promise<ExportResult>;
  /** The adapter's own progress for a job, ending when the adapter is closed. Optional. */
  getProgress?(jobId: string): AsyncIterable<ProgressEvent>;
  /** Stops work in flight for a job (kills a started process, drops queued plugin requests). Safe to call when idle. Optional. */
  cancel?(jobId: string): Promise<void>;
  /** The native payload a recipe turns into, without applying it (plan §2.2); also what dry runs validate. Optional. */
  translateRecipe?(recipe: EditRecipe, asset?: AssetRef): NativeEditPayload;
}
