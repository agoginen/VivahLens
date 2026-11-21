import { promises as fs } from "node:fs";
import path from "node:path";
import {
  runProcess,
  VivahError,
  type AdapterCapabilities,
  type ApplyResult,
  type AssetRef,
  type EditorAdapter,
  type EditRecipe,
  type ExportResult,
  type ExportSpec,
  type InstalledEditorInfo,
  type ProcessRunner,
} from "@vivahlens/core";
import { compileToPp3, SUPPORTED_FIELDS } from "./compile.js";

export interface RawTherapeeOptions {
  /** Path to the user-installed rawtherapee-cli. It is launched as a separate process, never linked (GPL). */
  binary?: string;
  run?: ProcessRunner;
}

/** `<image>.<ext>.pp3`, the sidecar name RawTherapee looks for next to the raw file. */
export function pp3Path(assetPath: string): string {
  return `${assetPath}.pp3`;
}

export class RawTherapeeAdapter implements EditorAdapter {
  readonly id = "rawtherapee";
  readonly capabilities: AdapterCapabilities = {
    mediaKinds: ["photo"],
    executionModel: "local-cli",
    requiresGuiOpen: false,
    os: ["windows", "macos"],
    supportedRecipeFields: SUPPORTED_FIELDS,
  };
  private readonly binary: string;
  private readonly run: ProcessRunner;

  constructor(opts: RawTherapeeOptions = {}) {
    this.binary = opts.binary ?? "rawtherapee-cli";
    this.run = opts.run ?? runProcess;
  }

  async detect(): Promise<InstalledEditorInfo | null> {
    const res = await this.run(this.binary, ["-v"]);
    if (res.code !== 0) return null;
    const version = /\d+\.\d+(\.\d+)?/.exec(res.stdout + res.stderr)?.[0];
    return { path: this.binary, version };
  }

  async applyRecipe(asset: AssetRef, recipe: EditRecipe): Promise<ApplyResult> {
    if (asset.kind !== "photo") throw new VivahError("ADAPTER_APPLY_FAILED", "RawTherapee adapter only supports photos");
    const file = pp3Path(asset.path);
    await fs.writeFile(file, compileToPp3(recipe), "utf8");
    return { assetId: asset.id, outputs: [file] };
  }

  async export(asset: AssetRef, spec: ExportSpec): Promise<ExportResult> {
    if (spec.maxEdgePx !== undefined) {
      throw new VivahError("ADAPTER_APPLY_FAILED", "RawTherapee adapter does not support resizing on export yet");
    }
    await fs.mkdir(spec.outputDir, { recursive: true });
    const ext = spec.format === "tiff" ? "tif" : "jpg";
    const out = path.join(spec.outputDir, `${path.parse(asset.path).name}.${ext}`);
    // -c must be the last option; -Y overwrites an existing output.
    const args = ["-o", out, "-p", pp3Path(asset.path), spec.format === "tiff" ? "-t" : `-j${spec.quality ?? 92}`, "-Y", "-c", asset.path];
    const res = await this.run(this.binary, args);
    if (res.code !== 0) {
      throw new VivahError("ADAPTER_APPLY_FAILED", `rawtherapee-cli exited with ${res.code}: ${res.stderr.slice(0, 300)}`);
    }
    return { assetId: asset.id, file: out };
  }
}
