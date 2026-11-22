import { detectShotBoundaries, percentile } from "./analysis.js";

/** Everything measured from one clip, independent of how it was decoded. */
export interface ClipFeatures {
  clipId: string;
  durationSec: number;
  /** Sampling rate of `motion` and `sharpness`. */
  sampleFps: number;
  /** Frame-to-frame change (0–1); element i compares sample i+1 with sample i. */
  motion: number[];
  /** Per-sample sharpness (e.g. Laplacian variance). */
  sharpness: number[];
  /** Loudness envelope (0–1) of the clip's own audio. */
  audio?: { hopSec: number; level: number[] };
  /** Position of the clip in the story (capture order); highlights are laid out in this order. */
  order: number;
}

export interface Segment {
  clipId: string;
  inSec: number;
  outSec: number;
  score: number;
  order: number;
}

export interface Weights {
  motion: number;
  audio: number;
  sharpness: number;
}

/** Shoot-wide reference levels (e.g. 90th percentiles over every clip), used to compare clips with each other. */
export interface References {
  motion: number;
  sharpness: number;
  audio: number;
}

export interface SegmentOptions {
  minSegSec?: number;
  maxSegSec?: number;
  weights?: Weights;
  /** Windows sharper than this share of the clip's own sharpness are dropped as blurry. */
  minSharpness?: number;
  /**
   * 0 scores each window only against its own clip (every clip's best moments look equally good);
   * 1 scores only against the whole shoot (lively clips dominate). The default blends both.
   */
  globalWeight?: number;
  /** Shoot-wide references for the global part; computed by `shootReferences`. */
  references?: References;
}

const mean = (values: readonly number[]): number => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 90th/95th-percentile levels over every clip, so a calm clip is not scored as if it were the liveliest. */
export function shootReferences(clips: readonly ClipFeatures[]): References {
  return {
    motion: percentile(clips.flatMap((c) => c.motion), 0.9) || 1,
    sharpness: percentile(clips.flatMap((c) => c.sharpness), 0.9) || 1,
    audio: percentile(clips.flatMap((c) => c.audio?.level ?? []), 0.95) || 1,
  };
}

/**
 * Cuts a clip into candidate highlight windows (at shot boundaries, at most `maxSegSec` long) and scores each by
 * motion, audio energy and sharpness, relative to the clip's own range and (by default, half-and-half) to the whole
 * shoot. Heuristic and tunable; there is no face or smile detection yet.
 */
export function buildSegments(clip: ClipFeatures, opts: SegmentOptions = {}): Segment[] {
  const { minSegSec = 2, maxSegSec = 8, minSharpness = 0.15 } = opts;
  const weights = opts.weights ?? { motion: 0.4, audio: 0.35, sharpness: 0.25 };
  const hasAudio = !!clip.audio && clip.audio.level.length > 0;
  const total = weights.motion + weights.sharpness + (hasAudio ? weights.audio : 0) || 1;
  const globalWeight = opts.references ? clamp01(opts.globalWeight ?? 0.5) : 0;

  const local = {
    motion: percentile(clip.motion, 0.9) || 1,
    sharpness: percentile(clip.sharpness, 0.9) || 1,
    audio: hasAudio ? percentile(clip.audio!.level, 0.95) || 1 : 1,
  };
  /** Blend of "good for this clip" and "good for this shoot", each clipped to 0–1. */
  const normalise = (value: number, kind: keyof References) =>
    (1 - globalWeight) * clamp01(value / local[kind]) + globalWeight * clamp01(value / (opts.references?.[kind] ?? local[kind]));

  const bounds = [0, ...detectShotBoundaries(clip.motion, clip.sampleFps).filter((t) => t > 0 && t < clip.durationSec), clip.durationSec];
  const segments: Segment[] = [];
  for (let s = 0; s + 1 < bounds.length; s++) {
    const [start, end] = [bounds[s]!, bounds[s + 1]!];
    const length = end - start;
    if (length < minSegSec) continue;
    const windows = Math.ceil(length / maxSegSec);
    const step = length / windows;
    for (let w = 0; w < windows; w++) {
      const inSec = start + w * step;
      const outSec = inSec + step;
      const i0 = Math.floor(inSec * clip.sampleFps);
      const i1 = Math.max(i0 + 1, Math.ceil(outSec * clip.sampleFps));
      const sharpRaw = mean(clip.sharpness.slice(i0, i1));
      // Blur is judged against the clip's own typical sharpness: a soft-focus clip is not "blurry" as a whole.
      if (clamp01(sharpRaw / local.sharpness) < minSharpness) continue;
      const sharp = normalise(sharpRaw, "sharpness");
      const motion = normalise(mean(clip.motion.slice(i0, i1)), "motion");
      let audio = 0;
      if (hasAudio) {
        const { hopSec, level } = clip.audio!;
        audio = normalise(mean(level.slice(Math.floor(inSec / hopSec), Math.ceil(outSec / hopSec))), "audio");
      }
      const score = (weights.motion * motion + weights.sharpness * sharp + (hasAudio ? weights.audio * audio : 0)) / total;
      segments.push({ clipId: clip.clipId, inSec, outSec, score, order: clip.order });
    }
  }
  return segments;
}

export interface Pick {
  clipId: string;
  availableIn: number;
  availableOut: number;
  score: number;
  order: number;
}

export interface SelectOptions {
  targetSec: number;
  maxSegSec?: number;
  minSegSec?: number;
  /** No clip may supply more than this share of the reel (relaxed automatically when there are few clips). */
  maxClipShare?: number;
}

/** Picks the best-scoring windows until the target length is covered, keeping variety across clips; returns them in story order. */
export function selectHighlights(segments: readonly Segment[], opts: SelectOptions): Pick[] {
  const { targetSec, maxSegSec = 8, maxClipShare = 0.5 } = opts;
  const clips = new Set(segments.map((s) => s.clipId)).size || 1;
  const budget = targetSec * 1.15;
  const clipCap = Math.max(maxClipShare, 1 / clips) * budget;

  const used = new Map<string, number>();
  let total = 0;
  const picks: Pick[] = [];
  for (const seg of [...segments].sort((a, b) => b.score - a.score || a.order - b.order || a.inSec - b.inSec)) {
    if (total >= budget) break;
    const len = Math.min(seg.outSec - seg.inSec, maxSegSec);
    if ((used.get(seg.clipId) ?? 0) + len > clipCap + 1e-9) continue;
    used.set(seg.clipId, (used.get(seg.clipId) ?? 0) + len);
    total += len;
    picks.push({ clipId: seg.clipId, availableIn: seg.inSec, availableOut: seg.outSec, score: seg.score, order: seg.order });
  }
  return picks.sort((a, b) => a.order - b.order || a.availableIn - b.availableIn);
}

export interface Cut {
  clipId: string;
  inSec: number;
  outSec: number;
}

const centred = (p: Pick, duration: number): Cut => {
  const spare = Math.max(0, p.availableOut - p.availableIn - duration);
  const inSec = p.availableIn + spare / 2;
  return { clipId: p.clipId, inSec, outSec: inSec + duration };
};

/** Trims picks to the target length: shortens the weakest down to the minimum, then drops them if still too long. */
export function fitToTarget(picks: readonly Pick[], opts: { targetSec: number; minSegSec?: number; maxSegSec?: number }): Cut[] {
  const { targetSec, minSegSec = 2, maxSegSec = 8 } = opts;
  const items = picks.map((p) => ({ p, d: Math.min(p.availableOut - p.availableIn, maxSegSec), alive: true }));
  const sum = () => items.filter((i) => i.alive).reduce((s, i) => s + i.d, 0);

  const weakest = () => items.filter((i) => i.alive).sort((a, b) => a.p.score - b.p.score);
  for (const i of weakest()) {
    const over = sum() - targetSec;
    if (over <= 1e-9) break;
    // Never shorten below the minimum, and never grow a window that was already shorter than it.
    i.d = Math.max(Math.min(minSegSec, i.d), i.d - over);
  }
  for (const i of weakest()) {
    if (sum() - targetSec <= 1e-9) break;
    if (items.filter((x) => x.alive).length > 1) i.alive = false;
  }
  return items.filter((i) => i.alive).map((i) => centred(i.p, i.d));
}

export interface BeatAlignment {
  cuts: Cut[];
  /** How many cuts end exactly on a beat. */
  alignedCuts: number;
}

/**
 * Lays picks out so every cut ends on a beat of the music (preferring bar lines), within each window's available
 * footage. Where beats are too sparse for a window, that cut is left unaligned rather than invented.
 */
export function alignToBeats(
  picks: readonly Pick[],
  beats: readonly number[],
  opts: { targetSec: number; minSegSec?: number; maxSegSec?: number; beatsPerBar?: number },
): BeatAlignment {
  const { targetSec, minSegSec = 2, maxSegSec = 8, beatsPerBar = 4 } = opts;
  if (beats.length < 2) return { cuts: fitToTarget(picks, opts), alignedCuts: 0 };

  const period = (beats[beats.length - 1]! - beats[0]!) / (beats.length - 1);
  const cuts: Cut[] = [];
  let aligned = 0;
  let t = 0;
  for (const p of picks) {
    // Stop once the target is (nearly) covered, but always lay out at least one cut.
    if (cuts.length > 0 && t >= targetSec - Math.min(period / 2, 1)) break;
    const room = Math.min(p.availableOut - p.availableIn, maxSegSec);
    const reachable = beats
      .map((b, k) => ({ b, k }))
      .filter(({ b }) => b - t >= minSegSec - 1e-9 && b - t <= room + 1e-9);
    // Do not overshoot the target by more than half a beat when an earlier beat is available.
    const withinTarget = reachable.filter(({ b }) => b <= targetSec + period / 2);
    const candidates = withinTarget.length ? withinTarget : reachable;
    if (!candidates.length) {
      cuts.push(centred(p, Math.max(Math.min(room, targetSec - t), 0.5)));
      t += cuts.at(-1)!.outSec - cuts.at(-1)!.inSec;
      continue;
    }
    const longest = candidates[candidates.length - 1]!;
    const barLine = [...candidates].reverse().find((c) => c.k % beatsPerBar === 0 && longest.b - c.b <= period * 1.01);
    const end = (barLine ?? longest).b;
    cuts.push(centred(p, end - t));
    aligned++;
    t = end;
  }
  return { cuts, alignedCuts: aligned };
}
