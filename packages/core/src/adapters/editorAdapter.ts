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
}

export interface InstalledEditorInfo {
  version?: string;
  path?: string;
}

export interface ApplyResult {
  assetId: string;
  /** Files written or modified by the adapter (sidecars, profiles). */
  outputs: string[];
}

export interface ExportSpec {
  format: "jpeg" | "tiff";
  /** Long edge in pixels; omitted = full resolution. */
  maxEdgePx?: number;
  quality?: number;
  outputDir: string;
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
  applyRecipe(asset: AssetRef, recipe: EditRecipe): Promise<ApplyResult>;
  export?(asset: AssetRef, spec: ExportSpec): Promise<ExportResult>;
}
