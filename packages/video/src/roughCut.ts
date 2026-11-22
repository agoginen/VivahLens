import { laplacianVariance } from "@vivahlens/core";
import { envelopeFromS16, estimateBeats, motionScores, type BeatGrid } from "./analysis.js";
import type { Ffmpeg, ProbedClip } from "./ffmpeg.js";
import {
  alignToBeats,
  buildSegments,
  fitToTarget,
  selectHighlights,
  shootReferences,
  type ClipFeatures,
  type Cut,
  type Pick,
  type SegmentOptions,
} from "./highlights.js";

const FRAME_W = 64;
const FRAME_H = 36;

/** Measures one clip with ffmpeg: motion, sharpness and loudness, ready for scoring. */
export async function analyzeClip(ff: Ffmpeg, clip: ProbedClip, order: number, sampleFps = 2): Promise<ClipFeatures> {
  const frames = await ff.sampleFrames(clip.path, { fps: sampleFps, width: FRAME_W, height: FRAME_H });
  const pcm = clip.hasAudio ? await ff.audioPcm(clip.path, 8000) : undefined;
  return {
    clipId: clip.clipId,
    durationSec: clip.durationSec,
    sampleFps,
    motion: motionScores(frames),
    sharpness: frames.map((data) => laplacianVariance({ width: FRAME_W, height: FRAME_H, data })),
    audio: pcm ? { hopSec: 0.1, level: envelopeFromS16(pcm, 8000, 0.1) } : undefined,
    order,
  };
}

/** Tempo and beat times of a music file, or undefined when no steady pulse is found. */
export async function analyzeMusic(ff: Ffmpeg, file: string): Promise<BeatGrid | undefined> {
  const pcm = await ff.audioPcm(file, 8000);
  return pcm ? estimateBeats(envelopeFromS16(pcm, 8000, 0.01), 0.01) : undefined;
}

export interface RoughCutOptions extends SegmentOptions {
  targetSec: number;
  maxClipShare?: number;
  /** When given, cut points land on its beats. */
  beats?: BeatGrid;
}

export interface RoughCutPlan {
  cuts: Cut[];
  totalSec: number;
  /** Seconds each clip contributes. */
  clipSeconds: Record<string, number>;
  alignedCuts: number;
  warnings: string[];
}

/** Step 1 of planning: which moments make the reel (chronological). Pure: all measurement happened in `analyzeClip`. */
export function choosePicks(features: readonly ClipFeatures[], opts: RoughCutOptions): { picks: Pick[]; warnings: string[] } {
  const { targetSec, minSegSec = 2, maxSegSec = 8 } = opts;
  const warnings: string[] = [];
  const segmentOpts = { ...opts, references: opts.references ?? (features.length > 1 ? shootReferences(features) : undefined) };
  const segments = features.flatMap((f) => buildSegments(f, segmentOpts));

  let picks = selectHighlights(segments, { targetSec, minSegSec, maxSegSec, maxClipShare: opts.maxClipShare });
  if (picks.length === 0 && features.length > 0) {
    // Nothing scored well (static or blurry footage): fall back to even samples so the reel is never empty.
    warnings.push("No lively moments were found; the reel uses evenly spaced samples from each clip.");
    const eligible = features.filter((f) => f.durationSec >= minSegSec);
    const each = Math.min(maxSegSec, Math.max(minSegSec, targetSec / Math.max(1, eligible.length)));
    picks = eligible.map((f) => {
      const len = Math.min(each, f.durationSec);
      const mid = f.durationSec / 2;
      return { clipId: f.clipId, availableIn: mid - len / 2, availableOut: mid + len / 2, score: 0, order: f.order };
    });
  }
  return { picks, warnings };
}

/** Step 2: lay the (possibly reordered) picks out to the target length, on the beat when a grid is given. */
export function layoutPicks(picks: readonly Pick[], opts: RoughCutOptions, warnings: string[] = []): RoughCutPlan {
  const { targetSec, minSegSec = 2, maxSegSec = 8 } = opts;
  const notes = [...warnings];
  let cuts: Cut[];
  let aligned = 0;
  if (opts.beats && opts.beats.beats.length >= 2) {
    ({ cuts, alignedCuts: aligned } = alignToBeats(picks, opts.beats.beats, { targetSec, minSegSec, maxSegSec }));
    if (aligned < cuts.length) notes.push(`${cuts.length - aligned} of ${cuts.length} cuts could not be placed on a beat.`);
  } else {
    cuts = fitToTarget(picks, { targetSec, minSegSec, maxSegSec });
  }

  const clipSeconds: Record<string, number> = {};
  for (const c of cuts) clipSeconds[c.clipId] = (clipSeconds[c.clipId] ?? 0) + (c.outSec - c.inSec);
  const totalSec = cuts.reduce((s, c) => s + c.outSec - c.inSec, 0);
  if (totalSec < targetSec * 0.8) notes.push(`Only ${totalSec.toFixed(1)}s of usable footage was found for a ${targetSec}s target.`);
  return { cuts, totalSec, clipSeconds, alignedCuts: aligned, warnings: notes };
}

/** Chooses and lays out the highlights in story order (capture order). */
export function planRoughCut(features: readonly ClipFeatures[], opts: RoughCutOptions): RoughCutPlan {
  const { picks, warnings } = choosePicks(features, opts);
  return layoutPicks(picks, opts, warnings);
}
