import {
  VivahError,
  type AdapterCapabilities,
  type ApplyResult,
  type AssetRef,
  type EditorAdapter,
  type EditRecipe,
  type InstalledEditorInfo,
} from "@vivahlens/core";
import { compileToCrsSettings, SUPPORTED_FIELDS } from "@vivahlens/adapter-xmp";
import type { PluginIpcServer } from "./ipc.js";

const META_KEYS = new Set(["Version", "ProcessVersion", "HasSettings"]);

/**
 * Develop settings as the Lightroom Classic plugin expects them: Camera Raw setting names with numeric values.
 * The names match the XMP `crs:` names the XMP adapter writes; confirming them against the SDK is a Phase 0 spike.
 */
export function compileToDevelopSettings(recipe: EditRecipe): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(compileToCrsSettings(recipe))) {
    if (META_KEYS.has(key)) continue;
    out[key] = /^[+-]?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return out;
}

/** Drives the user's own, already-running Lightroom Classic through the VivahLens plugin (local-plugin model). */
export class LightroomClassicAdapter implements EditorAdapter {
  readonly id = "lightroom-classic";
  readonly capabilities: AdapterCapabilities = {
    mediaKinds: ["photo"],
    executionModel: "local-plugin",
    requiresGuiOpen: true,
    os: ["windows", "macos"],
    supportedRecipeFields: SUPPORTED_FIELDS,
  };

  constructor(private readonly ipc: PluginIpcServer) {}

  async detect(): Promise<InstalledEditorInfo | null> {
    const hello = this.ipc.connected();
    return hello ? { version: hello.version } : null;
  }

  async applyRecipe(asset: AssetRef, recipe: EditRecipe): Promise<ApplyResult> {
    if (asset.kind !== "photo") throw new VivahError("ADAPTER_APPLY_FAILED", "Lightroom adapter only supports photos");
    await this.ipc.request({ type: "apply", path: asset.path, settings: compileToDevelopSettings(recipe) });
    return { assetId: asset.id, outputs: [] };
  }
}
