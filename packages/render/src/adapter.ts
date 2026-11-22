import { promises as fs } from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import {
  checkReadable,
  EditRecipeSchema,
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
  type ExportResult,
  type ExportSpec,
  type ImportResult,
  type InstalledEditorInfo,
  type NativeEditPayload,
} from "@vivahlens/core";
import { insertExif, loadExifSegment, loadRgba, patchExif, type Rgba } from "@vivahlens/ingest";
import { renderRecipe, RENDER_FIELDS } from "./render.js";

/** Where the built-in renderer keeps the recipe it was given for a picture. */
export function recipeSidecarPath(assetPath: string): string {
  const { dir, name } = path.parse(assetPath);
  return path.join(dir, `${name}.vivah.json`);
}

export interface RenderAdapterOptions {
  /** Where copies of a replaced recipe file are kept so `vivah undo` can put them back. */
  backupDir?: string;
  /** Replaces how the picture is read (tests). */
  load?(asset: AssetRef): Promise<Rgba>;
  /** Replaces how the picture's EXIF block is read (tests). */
  loadExif?(asset: AssetRef): Promise<Uint8Array | undefined>;
}

/** Encodes a picture as a JPEG, optionally carrying the source's EXIF block (upright, with the new pixel size). */
export function encodeJpeg(image: Rgba, quality: number, exif?: Uint8Array): Buffer {
  const encoded = jpeg.encode({ data: image.data, width: image.width, height: image.height }, quality).data;
  if (!exif) return Buffer.from(encoded);
  return Buffer.from(insertExif(encoded, patchExif(exif, { orientation: 1, width: image.width, height: image.height })));
}

/**
 * Edits pictures with VivahLens's own renderer, so an album can be finished with no photo editor installed. `apply`
 * keeps the recipe in a small file next to the picture; `export` draws it and writes a JPEG that keeps the camera's EXIF.
 * It works from a JPEG or a RAW file's embedded preview, so it is not a RAW developer.
 */
export class RenderAdapter implements EditorAdapter {
  readonly id = "builtin-render";
  readonly capabilities: AdapterCapabilities = {
    mediaKinds: ["photo"],
    executionModel: "local-cli",
    requiresGuiOpen: false,
    os: ["windows", "macos"],
    supportedRecipeFields: RENDER_FIELDS,
    exportResize: true,
    headless: true,
  };

  constructor(private readonly opts: RenderAdapterOptions = {}) {}

  async detect(): Promise<InstalledEditorInfo | null> {
    return { version: "builtin" };
  }

  importAssets(assets: readonly AssetRef[]): Promise<ImportResult> {
    return checkReadable(assets);
  }

  translateRecipe(recipe: EditRecipe): NativeEditPayload {
    return { kind: "vivah-recipe", payload: { recipe }, unsupported: unsupportedFields(recipe, RENDER_FIELDS) };
  }

  async cancel(): Promise<void> {}

  async applyRecipe(asset: AssetRef, recipe: EditRecipe, ctx?: AdapterContext): Promise<ApplyResult> {
    if (asset.kind !== "photo") throw new VivahError("ADAPTER_APPLY_FAILED", "The built-in renderer only edits photos");
    throwIfCancelled(ctx);
    const checked = EditRecipeSchema.safeParse(recipe);
    if (!checked.success) throw new VivahError("ADAPTER_APPLY_FAILED", `The recipe is not valid: ${checked.error.issues[0]?.message ?? "unknown problem"}`);
    const sidecar = recipeSidecarPath(asset.path);
    const { replaced, warning } = await writeReplacing(sidecar, `${JSON.stringify({ app: "vivahlens", recipe: checked.data }, null, 2)}\n`, { backupDir: jobBackupDir(this.opts.backupDir, ctx) });
    const unsupported = unsupportedFields(recipe, RENDER_FIELDS);
    const warnings = [...(unsupported.length ? [`The built-in renderer does not draw: ${unsupported.join(", ")}`] : []), ...(warning ? [warning] : [])];
    return { assetId: asset.id, outputs: [sidecar], ...(replaced && { replaced: [replaced] }), ...(warnings.length && { warnings }) };
  }

  async export(asset: AssetRef, spec: ExportSpec, ctx?: AdapterContext): Promise<ExportResult> {
    throwIfCancelled(ctx);
    if (spec.format !== "jpeg") throw new VivahError("ADAPTER_APPLY_FAILED", "The built-in renderer exports JPEG only");
    const recipe = await this.readRecipe(asset);
    const source = await (this.opts.load ?? ((a: AssetRef) => loadRgba(a)))(asset);
    throwIfCancelled(ctx);
    const rendered = renderRecipe(source, recipe, spec.maxEdgePx ? { maxEdge: spec.maxEdgePx } : {});
    const exif = await (this.opts.loadExif ?? loadExifSegment)(asset).catch(() => undefined);
    throwIfCancelled(ctx);
    await fs.mkdir(spec.outputDir, { recursive: true });
    const file = path.join(spec.outputDir, `${path.basename(spec.fileName ?? path.parse(asset.path).name)}.jpg`);
    await writeReplacing(file, encodeJpeg(rendered, spec.quality ?? 90, exif));
    return { assetId: asset.id, file };
  }

  private async readRecipe(asset: AssetRef): Promise<EditRecipe> {
    const sidecar = recipeSidecarPath(asset.path);
    let text: string;
    try {
      text = await fs.readFile(sidecar, "utf8");
    } catch {
      throw new VivahError("ADAPTER_APPLY_FAILED", `No recipe has been applied to ${path.basename(asset.path)} yet`);
    }
    try {
      return EditRecipeSchema.parse((JSON.parse(text) as { recipe?: unknown }).recipe);
    } catch {
      throw new VivahError("ADAPTER_APPLY_FAILED", `${path.basename(sidecar)} does not hold a valid recipe`);
    }
  }
}
