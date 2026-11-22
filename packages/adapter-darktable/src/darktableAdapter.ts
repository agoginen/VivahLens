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
import { compileToHistory, SUPPORTED_FIELDS } from "./compile.js";
import { buildSidecar, mergeSidecar } from "./sidecar.js";

export interface DarktableOptions {
  /** Path to the user-installed darktable-cli. It is launched as a separate process, never linked (darktable is GPL). */
  binary?: string;
  run?: ProcessRunner;
  /** Where copies of existing sidecars are kept before they are changed, so `vivah undo` can put them back. */
  backupDir?: string;
  /** darktable's own settings folder for exports, so the person's darktablerc (quality, overwrite, workflow) cannot change a result. */
  configDir?: string;
}

/** `<image>.<ext>.xmp`: the sidecar name darktable writes and reads next to a raw file (not `<image>.xmp`, which is Lightroom's). */
export function sidecarPath(assetPath: string): string {
  return `${assetPath}.xmp`;
}

/** The parameter layouts this adapter writes were read from darktable 5.6's source; an older darktable has different ones. */
export const MIN_VERSION = { major: 5, minor: 6 } as const;

const RAW_EXTENSIONS = new Set([".3fr", ".arw", ".cr2", ".cr3", ".crw", ".dcr", ".dng", ".erf", ".kdc", ".mef", ".mrw", ".nef", ".nrw", ".orf", ".pef", ".raf", ".raw", ".rw2", ".rwl", ".sr2", ".srf", ".srw", ".x3f"]);

const isAtLeastMin = (version: string): boolean => {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > MIN_VERSION.major || (major === MIN_VERSION.major && minor >= MIN_VERSION.minor);
};

/** The first bytes of a finished image, so an empty or wrong file is not mistaken for one. */
async function looksLikeImage(file: string, format: ExportSpec["format"]): Promise<boolean> {
  const handle = await fs.open(file, "r").catch(() => undefined);
  if (!handle) return false;
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    if (bytesRead < 4) return false;
    return format === "tiff" ? head.equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || head.equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])) : head[0] === 0xff && head[1] === 0xd8;
  } finally {
    await handle.close();
  }
}

/**
 * Edits raw files for darktable (plan §2.7, Phase 1): the recipe becomes history entries in the photo's own darktable
 * sidecar, merged into whatever is already there; exports run `darktable-cli` once per photo against that sidecar.
 * It speaks darktable's native format because darktable's importer for Lightroom settings runs only in its window and
 * covers neither white balance, contrast nor saturation. Nothing here has been run against a real darktable: the layouts
 * come from reading its source, which is why the adapter checks the installed version and is marked beta.
 */
export class DarktableAdapter implements EditorAdapter {
  readonly id = "darktable";
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
  private readonly configDir: string;
  private version: string | undefined;
  /** darktable-cli is heavy and keeps its settings in one folder, so exports run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly running = new Map<string, Set<AbortController>>();

  constructor(opts: DarktableOptions = {}) {
    this.binary = opts.binary ?? "darktable-cli";
    this.run = opts.run ?? runProcess;
    this.backupDir = opts.backupDir;
    this.configDir = opts.configDir ?? path.join(os.tmpdir(), "vivahlens-darktable");
  }

  async detect(): Promise<InstalledEditorInfo | null> {
    const res = await this.run(this.binary, ["--version"]);
    if (res.code !== 0) return null;
    const text = `${res.stdout}\n${res.stderr}`;
    this.version = /darktable[\w-]*\s+(?:version\s+)?(\d+\.\d+(?:\.\d+)?)/i.exec(text)?.[1] ?? /\d+\.\d+(?:\.\d+)?/.exec(text)?.[0];
    return { path: this.binary, ...(this.version && { version: this.version }) };
  }

  importAssets(assets: readonly AssetRef[]): Promise<ImportResult> {
    return checkReadable(assets);
  }

  translateRecipe(recipe: EditRecipe, asset?: AssetRef): NativeEditPayload {
    const { entries, warnings } = compileToHistory(recipe);
    return {
      kind: "darktable-xmp",
      payload: buildSidecar(asset ? path.basename(asset.path) : "image.raw", entries),
      unsupported: unsupportedFields(recipe, SUPPORTED_FIELDS),
      ...(warnings.length && { warnings }),
    };
  }

  /** Stops the exports in flight for a job: their processes are killed and the partial files removed. */
  async cancel(jobId: string): Promise<void> {
    for (const controller of this.running.get(jobId) ?? []) controller.abort();
  }

  /** Refuses an installed darktable whose parameter layouts differ from the ones written here. A version not yet detected is not refused. */
  private assertSupportedVersion(): void {
    if (this.version !== undefined && !isAtLeastMin(this.version)) {
      throw new VivahError("ADAPTER_VERSION_UNSUPPORTED", `darktable ${this.version} is older than ${MIN_VERSION.major}.${MIN_VERSION.minor}, whose module parameters this adapter writes; update darktable or use another editor`);
    }
  }

  async applyRecipe(asset: AssetRef, recipe: EditRecipe, ctx?: AdapterContext): Promise<ApplyResult> {
    if (asset.kind !== "photo") throw new VivahError("ADAPTER_APPLY_FAILED", "The darktable adapter only supports photos");
    throwIfCancelled(ctx);
    const name = path.basename(asset.path);
    if (!RAW_EXTENSIONS.has(path.extname(asset.path).toLowerCase())) {
      throw new VivahError("ADAPTER_APPLY_FAILED", `${name} is not a raw file; the darktable adapter writes darktable's raw-file sidecars`);
    }
    this.assertSupportedVersion();

    const { entries, warnings } = compileToHistory(recipe);
    // Nothing darktable can do for this recipe: leave the photo and its sidecar exactly as they are.
    if (entries.length === 0) return { assetId: asset.id, outputs: [], ...(warnings.length && { warnings }) };

    const file = sidecarPath(asset.path);
    const { replaced, warning } = await writeReplacing(file, (before) => mergeSidecar(before?.toString("utf8"), entries, { file: path.basename(file), derivedFrom: name }), { backupDir: jobBackupDir(this.backupDir, ctx) });
    if (warning) warnings.push(warning);
    return { assetId: asset.id, outputs: [file], ...(replaced && { replaced: [replaced] }), ...(warnings.length && { warnings }) };
  }

  export(asset: AssetRef, spec: ExportSpec, ctx?: AdapterContext): Promise<ExportResult> {
    const work = this.queue.then(() => this.exportOne(asset, spec, ctx));
    this.queue = work.catch(() => undefined);
    return work;
  }

  private async exportOne(asset: AssetRef, spec: ExportSpec, ctx?: AdapterContext): Promise<ExportResult> {
    throwIfCancelled(ctx);
    this.assertSupportedVersion();
    await fs.mkdir(spec.outputDir, { recursive: true });
    await fs.mkdir(this.configDir, { recursive: true });
    const extension = spec.format === "tiff" ? "tif" : "jpg";
    const out = path.join(spec.outputDir, `${path.basename(spec.fileName ?? path.parse(asset.path).name)}.${extension}`);
    // darktable renames rather than replaces unless told otherwise; with nothing there, a file at `out` is certainly this export's.
    await fs.rm(out, { force: true });

    const sidecar = sidecarPath(asset.path);
    const hasSidecar = await fs.stat(sidecar).then(() => true, () => false);
    const args = [
      asset.path,
      ...(hasSidecar ? [sidecar] : []),
      out,
      "--out-ext",
      extension,
      "--hq",
      "true",
      "--apply-custom-presets",
      "false",
      ...(spec.maxEdgePx !== undefined ? ["--width", String(spec.maxEdgePx), "--height", String(spec.maxEdgePx)] : []),
      "--core",
      "--configdir",
      this.configDir,
      "--conf",
      spec.format === "tiff" ? "plugins/imageio/format/tiff/bpp=16" : `plugins/imageio/format/jpeg/quality=${Math.min(100, Math.max(5, Math.round(spec.quality ?? 92)))}`,
      "--conf",
      "plugins/imageio/storage/disk/overwrite=1",
    ];

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

    // darktable-cli exits 1 for every failure and may exit 0 without a file (a skipped output): trust neither without the image.
    const wrote = res.code === 0 && !controller.signal.aborted && (await looksLikeImage(out, spec.format));
    if (!wrote) {
      await fs.rm(out, { force: true }).catch(() => undefined);
      if (controller.signal.aborted) throw new VivahError("ADAPTER_CANCELLED", `Export of ${path.basename(asset.path)} was cancelled`);
      throw new VivahError("ADAPTER_APPLY_FAILED", res.code === 0 ? `darktable-cli finished without writing a usable ${path.basename(out)}` : `darktable-cli exited with ${res.code}: ${res.stderr.slice(0, 300)}`);
    }
    return { assetId: asset.id, file: out };
  }
}
