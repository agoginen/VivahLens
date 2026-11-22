import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkReadable,
  jobBackupDir,
  runProcess,
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
  type ProcessRunner,
} from "@vivahlens/core";
import { compileToPp3Detailed, resizeProfile, SUPPORTED_FIELDS } from "./compile.js";

export interface RawTherapeeOptions {
  /** Path to the user-installed rawtherapee-cli. It is launched as a separate process, never linked (GPL). */
  binary?: string;
  run?: ProcessRunner;
  /** Where copies of existing PP3 sidecars are kept before they are replaced, so `vivah undo` can put them back. Without it a photographer's own sidecar is still replaced, but that cannot be undone. */
  backupDir?: string;
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
    exportResize: true,
    headless: true,
  };
  private readonly binary: string;
  private readonly run: ProcessRunner;
  private readonly backupDir: string | undefined;
  /** Controllers of the exports running per job, so a cancel reaches the processes already started. */
  private readonly running = new Map<string, Set<AbortController>>();

  constructor(opts: RawTherapeeOptions = {}) {
    this.binary = opts.binary ?? "rawtherapee-cli";
    this.run = opts.run ?? runProcess;
    this.backupDir = opts.backupDir;
  }

  async detect(): Promise<InstalledEditorInfo | null> {
    const res = await this.run(this.binary, ["-v"]);
    if (res.code !== 0) return null;
    const version = /\d+\.\d+(\.\d+)?/.exec(res.stdout + res.stderr)?.[0];
    return { path: this.binary, version };
  }

  /** RawTherapee needs no import step; this only finds files that are missing before a sidecar is written for them. */
  importAssets(assets: readonly AssetRef[]): Promise<ImportResult> {
    return checkReadable(assets);
  }

  translateRecipe(recipe: EditRecipe): NativeEditPayload {
    const { pp3, warnings } = compileToPp3Detailed(recipe);
    return { kind: "pp3", payload: pp3, unsupported: unsupportedFields(recipe, SUPPORTED_FIELDS), ...(warnings.length && { warnings }) };
  }

  /** Stops the exports in flight for a job: their processes are killed and the partial files removed. */
  async cancel(jobId: string): Promise<void> {
    for (const controller of this.running.get(jobId) ?? []) controller.abort();
  }

  async applyRecipe(asset: AssetRef, recipe: EditRecipe, ctx?: AdapterContext): Promise<ApplyResult> {
    if (asset.kind !== "photo") throw new VivahError("ADAPTER_APPLY_FAILED", "RawTherapee adapter only supports photos");
    throwIfCancelled(ctx);
    const file = pp3Path(asset.path);
    const { pp3, warnings } = compileToPp3Detailed(recipe);
    const { replaced, warning } = await writeReplacing(file, pp3, { backupDir: jobBackupDir(this.backupDir, ctx) });
    if (warning) warnings.push(warning);
    return { assetId: asset.id, outputs: [file], ...(replaced && { replaced: [replaced] }), ...(warnings.length && { warnings }) };
  }

  async export(asset: AssetRef, spec: ExportSpec, ctx?: AdapterContext): Promise<ExportResult> {
    throwIfCancelled(ctx);
    await fs.mkdir(spec.outputDir, { recursive: true });
    const ext = spec.format === "tiff" ? "tif" : "jpg";
    const out = path.join(spec.outputDir, `${path.basename(spec.fileName ?? path.parse(asset.path).name)}.${ext}`);

    // A size ceiling is a second profile layered over the recipe's (`-p` options apply in order), kept out of the delivery folder.
    const scratch = spec.maxEdgePx !== undefined ? await fs.mkdtemp(path.join(os.tmpdir(), "vivah-rt-")) : undefined;
    try {
      const profiles = [pp3Path(asset.path)];
      if (scratch !== undefined) {
        const resize = path.join(scratch, "resize.pp3");
        await fs.writeFile(resize, resizeProfile(spec.maxEdgePx!), "utf8");
        profiles.push(resize);
      }
      // -c must be the last option; -Y overwrites an existing output; -js3 is passed because the CLI's usage text and code disagree on its default.
      const args = ["-q", "-Y", "-o", out, ...profiles.flatMap((p) => ["-p", p]), spec.format === "tiff" ? "-t" : `-j${spec.quality ?? 92}`, ...(spec.format === "tiff" ? [] : ["-js3"]), "-c", asset.path];

      const controller = new AbortController();
      const key = ctx?.jobId ?? "";
      this.running.set(key, (this.running.get(key) ?? new Set()).add(controller));
      const onAbort = () => controller.abort();
      ctx?.signal?.addEventListener("abort", onAbort, { once: true });
      let res;
      try {
        res = await this.run(this.binary, args, { signal: controller.signal });
      } finally {
        ctx?.signal?.removeEventListener("abort", onAbort);
        this.running.get(key)?.delete(controller);
        if (this.running.get(key)?.size === 0) this.running.delete(key);
      }
      // A skipped output still exits 0 and an unknown option exits with a negative code: trust neither without the file.
      const wrote = res.code === 0 && !controller.signal.aborted && (await fs.stat(out).then((s) => s.size > 0, () => false));
      if (!wrote) {
        // A half-written image must never be left where it could be mistaken for a finished one.
        await fs.rm(out, { force: true }).catch(() => undefined);
        if (controller.signal.aborted) throw new VivahError("ADAPTER_CANCELLED", `Export of ${path.basename(asset.path)} was cancelled`);
        throw new VivahError("ADAPTER_APPLY_FAILED", res.code === 0 ? `rawtherapee-cli finished without writing ${path.basename(out)}` : `rawtherapee-cli exited with ${res.code}: ${res.stderr.slice(0, 300)}`);
      }
      return { assetId: asset.id, file: out };
    } finally {
      if (scratch !== undefined) await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
