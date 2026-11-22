import {
  throwIfCancelled,
  unsupportedFields,
  VivahError,
  type AdapterCapabilities,
  type AdapterContext,
  type ApplyResult,
  type AssetRef,
  type EditorAdapter,
  type EditRecipe,
  type ImportResult,
  type InstalledEditorInfo,
  type NativeEditPayload,
  type PluginBridge,
  type ProgressEvent,
} from "@vivahlens/core";
import { compileToCrsSettings, BASIC_FIELDS } from "@vivahlens/adapter-xmp";

const META_KEYS = new Set(["Version", "ProcessVersion", "HasSettings"]);

/** Importing a large folder takes Lightroom far longer than one apply. */
const IMPORT_TIMEOUT_MS = 5 * 60_000;

/**
 * Develop settings as the Lightroom Classic plugin expects them: Camera Raw setting names with numeric values.
 * The names match the XMP `crs:` names the XMP adapter writes; confirming them against the SDK is a Phase 0 spike, so only
 * the long-established fields go through the plugin for now.
 */
export function compileToDevelopSettings(recipe: EditRecipe): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(compileToCrsSettings(recipe, BASIC_FIELDS))) {
    if (META_KEYS.has(key)) continue;
    out[key] = /^[+-]?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return out;
}

/** Lightroom reports paths in its own spelling (separators, drive-letter case), and Windows and macOS ignore case. */
const pathKey = (p: string) => p.replace(/\\/g, "/").toLowerCase();

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** Drives the user's own, already-running Lightroom Classic through the VivahLens plugin (local-plugin model). */
export class LightroomClassicAdapter implements EditorAdapter {
  readonly id = "lightroom-classic";
  readonly capabilities: AdapterCapabilities = {
    mediaKinds: ["photo"],
    executionModel: "local-plugin",
    requiresGuiOpen: true,
    os: ["windows", "macos"],
    supportedRecipeFields: BASIC_FIELDS,
    headless: false,
  };

  constructor(private readonly ipc: PluginBridge) {}

  async detect(): Promise<InstalledEditorInfo | null> {
    const hello = this.ipc.connected();
    return hello ? { version: hello.host ?? hello.version } : null;
  }

  /** Has the plugin add the files to the catalog (develop settings can only be applied to photos Lightroom knows). Every file is accounted for: imported or skipped with a reason. */
  async importAssets(assets: readonly AssetRef[], ctx?: AdapterContext): Promise<ImportResult> {
    throwIfCancelled(ctx);
    const reply = await this.ipc.request({ type: "import", paths: assets.map((a) => a.path) }, { jobId: ctx?.jobId, signal: ctx?.signal, timeoutMs: IMPORT_TIMEOUT_MS });
    const imported = new Set(strings(reply.imported).map(pathKey));
    const refused = new Map<string, string>();
    if (Array.isArray(reply.skipped)) {
      for (const s of reply.skipped as unknown[]) {
        if (s && typeof s === "object" && typeof (s as { path?: unknown }).path === "string") {
          const { path, reason } = s as { path: string; reason?: unknown };
          refused.set(pathKey(path), typeof reason === "string" && reason ? reason : "Lightroom did not import it");
        }
      }
    }
    const result: ImportResult = { imported: [], skipped: [] };
    for (const asset of assets) {
      const key = pathKey(asset.path);
      if (refused.has(key)) result.skipped.push({ assetId: asset.id, reason: refused.get(key)! });
      else if (imported.has(key)) result.imported.push(asset.id);
      else result.skipped.push({ assetId: asset.id, reason: "Lightroom did not say whether it imported this file" });
    }
    return result;
  }

  translateRecipe(recipe: EditRecipe): NativeEditPayload {
    return { kind: "develop-settings", payload: compileToDevelopSettings(recipe), unsupported: unsupportedFields(recipe, BASIC_FIELDS) };
  }

  getProgress(jobId: string): AsyncIterable<ProgressEvent> {
    return this.ipc.progress.subscribe(jobId);
  }

  /** Stops waiting on Lightroom and has the plugin drop what it queued for the job. A photo Lightroom is already working on finishes. */
  async cancel(jobId: string): Promise<void> {
    this.ipc.cancelJob(jobId);
  }

  async applyRecipe(asset: AssetRef, recipe: EditRecipe, ctx?: AdapterContext): Promise<ApplyResult> {
    if (asset.kind !== "photo") throw new VivahError("ADAPTER_APPLY_FAILED", "Lightroom adapter only supports photos");
    throwIfCancelled(ctx);
    await this.ipc.request({ type: "apply", path: asset.path, settings: compileToDevelopSettings(recipe) }, { jobId: ctx?.jobId, signal: ctx?.signal });
    return { assetId: asset.id, outputs: [] };
  }
}
