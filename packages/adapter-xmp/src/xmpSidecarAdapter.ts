import path from "node:path";
import {
  checkReadable,
  jobBackupDir,
  throwIfCancelled,
  unsupportedFields,
  VivahError,
  writeReplacing,
  type AdapterCapabilities,
  type AdapterContext,
  type ApplyResult,
  type AssetRef,
  type EditorAdapter,
  type EditRecipe,
  type ImportResult,
  type InstalledEditorInfo,
  type NativeEditPayload,
} from "@vivahlens/core";
import { buildXmp, compileToCrs, mergeXmp, SUPPORTED_FIELDS } from "./compile.js";

/** Formats whose develop settings Lightroom and Camera Raw store in the file itself, so a sidecar next to them is not read (Camera Raw help). */
const STORES_SETTINGS_IN_FILE = /\.(jpe?g|tiff?|png|heic|webp)$/i;

export function sidecarPath(assetPath: string): string {
  const { dir, name } = path.parse(assetPath);
  return path.join(dir, `${name}.xmp`);
}

export interface XmpSidecarOptions {
  /** Where copies of sidecars are kept before they are changed, so `vivah undo` can put them back. Without it an existing sidecar is still merged into, but that cannot be undone. */
  backupDir?: string;
}

/**
 * File-interchange adapter: writes Camera Raw settings into XMP sidecars that Lightroom, ACR and Bridge read.
 * Lightroom Classic flags externally-changed sidecars, so the photographer must run "Read Metadata from File".
 * Needs no installed editor, so it also works on a machine that only holds the files. Sidecars are replaced
 * atomically and read back, and what they held before is kept, so a failed or unwanted apply never costs the
 * photographer their own edits.
 */
export class XmpSidecarAdapter implements EditorAdapter {
  readonly id = "xmp-sidecar";
  readonly capabilities: AdapterCapabilities = {
    mediaKinds: ["photo"],
    executionModel: "local-cli",
    requiresGuiOpen: false,
    os: ["windows", "macos"],
    supportedRecipeFields: SUPPORTED_FIELDS,
    headless: true,
    fileDrivenOnly: true,
  };

  constructor(private readonly opts: XmpSidecarOptions = {}) {}

  async detect(): Promise<InstalledEditorInfo | null> {
    return {};
  }

  /** There is nothing to import into: the editor reads the sidecar next to the file. This only finds files that are missing before a sidecar is written for them. */
  importAssets(assets: readonly AssetRef[]): Promise<ImportResult> {
    return checkReadable(assets);
  }

  translateRecipe(recipe: EditRecipe): NativeEditPayload {
    const { attributes, sequences, warnings } = compileToCrs(recipe);
    return { kind: "xmp", payload: buildXmp(attributes, sequences), unsupported: unsupportedFields(recipe, SUPPORTED_FIELDS), ...(warnings.length && { warnings }) };
  }

  /** Writing a sidecar takes milliseconds and is never left half done, so there is never anything in flight to stop. */
  async cancel(): Promise<void> {}

  async applyRecipe(asset: AssetRef, recipe: EditRecipe, ctx?: AdapterContext): Promise<ApplyResult> {
    if (asset.kind !== "photo") throw new VivahError("ADAPTER_APPLY_FAILED", "XMP sidecar adapter only supports photos");
    throwIfCancelled(ctx);
    const { attributes, sequences, warnings } = compileToCrs(recipe);
    const xmpPath = sidecarPath(asset.path);
    if (STORES_SETTINGS_IN_FILE.test(asset.path)) {
      warnings.push(`Lightroom and Camera Raw keep a ${path.extname(asset.path).slice(1).toUpperCase()} photo's settings inside the file and ignore a sidecar for it; this edit only reaches editors that read ${path.basename(xmpPath)}.`);
    }
    const { replaced, warning } = await writeReplacing(
      xmpPath,
      (before) => (before ? mergeXmp(before.toString("utf8"), attributes, sequences) : buildXmp(attributes, sequences)),
      { backupDir: jobBackupDir(this.opts.backupDir, ctx) },
    );
    if (warning) warnings.push(warning);
    return { assetId: asset.id, outputs: [xmpPath], ...(replaced && { replaced: [replaced] }), ...(warnings.length && { warnings }) };
  }
}
