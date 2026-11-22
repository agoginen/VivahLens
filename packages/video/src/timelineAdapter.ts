import { promises as fs } from "node:fs";
import path from "node:path";
import {
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
  type InstalledEditorInfo,
  type NativeEditPayload,
} from "@vivahlens/core";
import { toEdl } from "./edl.js";
import { toFcpxml, type FcpxmlOptions } from "./fcpxml.js";
import type { Fps } from "./time.js";
import type { ClipInfo, MusicTrack, TimelineCut, TimelineSpec } from "./timeline.js";

export interface TimelineAdapterOptions {
  format: "fcpxml" | "edl";
  /** The clips the recipe's `clipId`s refer to. */
  clips: readonly ClipInfo[];
  /** Sequence settings; default to the first clip's. */
  fps?: Fps;
  width?: number;
  height?: number;
  fcpxml?: FcpxmlOptions;
  /** Music laid under the whole timeline (see `MusicTrack`). */
  music?: MusicTrack;
  /** How long a crossfade takes, in seconds. */
  transitionSec?: number;
  /** Write the sequence's timecode drop-frame (29.97 and 59.94 only). */
  dropFrame?: boolean;
  /** Where a timeline file that is about to be replaced is copied first, so `vivah undo` can put it back. */
  backupDir?: string;
}

const EXTENSION = { fcpxml: ".fcpxml", edl: ".edl" } as const;
const SUPPORTED = ["videoEdits"] as const;

/**
 * Turns a video recipe's cuts into a timeline file the editor opens: FCPXML (Final Cut Pro, DaVinci Resolve) or a
 * CMX 3600 EDL (Premiere Pro, Resolve, most others). The asset is the timeline to write: its path is the output
 * location (the extension is added when missing). Rendering and colour stay in the user's editor.
 */
export class TimelineFileAdapter implements EditorAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities = {
    mediaKinds: ["video"],
    executionModel: "local-cli",
    requiresGuiOpen: false,
    os: ["windows", "macos"],
    supportedRecipeFields: SUPPORTED,
    headless: true,
    fileDrivenOnly: true,
  };

  constructor(private readonly opts: TimelineAdapterOptions) {
    this.id = opts.format === "fcpxml" ? "fcpxml-timeline" : "edl-timeline";
  }

  async detect(): Promise<InstalledEditorInfo | null> {
    return {};
  }

  /** The timeline file is written in one step and never left half done, so there is never anything in flight to stop. */
  async cancel(): Promise<void> {}

  translateRecipe(recipe: EditRecipe, asset?: AssetRef): NativeEditPayload {
    const exported = this.build(path.parse(asset?.path ?? "timeline").name, recipe);
    return { kind: this.opts.format, payload: exported.text, unsupported: unsupportedFields(recipe, SUPPORTED), ...(exported.warnings.length && { warnings: exported.warnings }) };
  }

  private build(name: string, recipe: EditRecipe): { text: string; warnings: string[] } {
    const cuts = recipe.adjustments.videoEdits?.cuts;
    if (!cuts?.length) throw new VivahError("ADAPTER_APPLY_FAILED", "The recipe has no video cuts to turn into a timeline");
    const first = this.opts.clips[0];
    if (!first) throw new VivahError("ADAPTER_APPLY_FAILED", "No clips were provided for the timeline");

    const spec: TimelineSpec = {
      name,
      fps: this.opts.fps ?? first.fps,
      width: this.opts.width ?? first.width,
      height: this.opts.height ?? first.height,
      clips: this.opts.clips,
      cuts: cuts as TimelineCut[],
      ...(this.opts.music && { music: this.opts.music }),
      ...(this.opts.transitionSec !== undefined && { transitionSec: this.opts.transitionSec }),
      ...(this.opts.dropFrame && { dropFrame: true }),
    };
    try {
      return this.opts.format === "fcpxml" ? toFcpxml(spec, this.opts.fcpxml) : toEdl(spec);
    } catch (err) {
      throw new VivahError("ADAPTER_APPLY_FAILED", err instanceof Error ? err.message : String(err));
    }
  }

  async applyRecipe(asset: AssetRef, recipe: EditRecipe, ctx?: AdapterContext): Promise<ApplyResult> {
    if (asset.kind !== "video") throw new VivahError("ADAPTER_APPLY_FAILED", "Timeline adapter only supports video");
    throwIfCancelled(ctx);
    const exported = this.build(path.parse(asset.path).name, recipe);

    const ext = EXTENSION[this.opts.format];
    const file = asset.path.toLowerCase().endsWith(ext) ? asset.path : `${asset.path}${ext}`;
    await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
    const { replaced, warning } = await writeReplacing(file, exported.text, { backupDir: jobBackupDir(this.opts.backupDir, ctx) });
    const warnings = [...exported.warnings, ...(warning ? [warning] : [])];
    return { assetId: asset.id, outputs: [file], ...(replaced && { replaced: [replaced] }), ...(warnings.length && { warnings }) };
  }
}
