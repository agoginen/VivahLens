import { promises as fs } from "node:fs";
import path from "node:path";
import {
  VivahError,
  type AdapterCapabilities,
  type ApplyResult,
  type AssetRef,
  type EditorAdapter,
  type EditRecipe,
  type InstalledEditorInfo,
} from "@vivahlens/core";
import { buildXmp, compileToCrsSettings, mergeXmp, SUPPORTED_FIELDS } from "./compile.js";

export function sidecarPath(assetPath: string): string {
  const { dir, name } = path.parse(assetPath);
  return path.join(dir, `${name}.xmp`);
}

/**
 * File-interchange adapter: writes Camera Raw settings into XMP sidecars that Lightroom, ACR and Bridge read.
 * Lightroom Classic flags externally-changed sidecars, so the photographer must run "Read Metadata from File".
 * Needs no installed editor, so it also works on a machine that only holds the files.
 */
export class XmpSidecarAdapter implements EditorAdapter {
  readonly id = "xmp-sidecar";
  readonly capabilities: AdapterCapabilities = {
    mediaKinds: ["photo"],
    executionModel: "local-cli",
    requiresGuiOpen: false,
    os: ["windows", "macos"],
    supportedRecipeFields: SUPPORTED_FIELDS,
  };

  async detect(): Promise<InstalledEditorInfo | null> {
    return {};
  }

  async applyRecipe(asset: AssetRef, recipe: EditRecipe): Promise<ApplyResult> {
    if (asset.kind !== "photo") throw new VivahError("ADAPTER_APPLY_FAILED", "XMP sidecar adapter only supports photos");
    const settings = compileToCrsSettings(recipe);
    const xmpPath = sidecarPath(asset.path);
    let existing: string | undefined;
    try {
      existing = await fs.readFile(xmpPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await fs.writeFile(xmpPath, existing ? mergeXmp(existing, settings) : buildXmp(settings), "utf8");
    return { assetId: asset.id, outputs: [xmpPath] };
  }
}
