/** Mean absolute difference (0–1) between consecutive sampled frames; element i compares frame i+1 with frame i. */
export function motionScores(frames: readonly Uint8Array[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!;
    const b = frames[i]!;
    const n = Math.min(a.length, b.length);
    let sum = 0;
    for (let p = 0; p < n; p++) sum += Math.abs(a[p]! - b[p]!);
    out.push(n ? sum / n / 255 : 0);
  }
  return out;
}

const median = (values: readonly number[]): number => {
  if (!values.length) return 0;
  const s = [...values].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export interface ShotOptions {
  /** A cut needs at least this much frame-to-frame change (0–1). */
  absolute?: number;
  /** ...and must exceed the local median change by this factor, so fast action is not mistaken for a cut. */
  relative?: number;
  /** Neighbouring samples on each side used for the local median. */
  window?: number;
}

/** Times (seconds) where a new shot starts, from motion scores of frames sampled at `sampleFps`. */
export function detectShotBoundaries(motion: readonly number[], sampleFps: number, opts: ShotOptions = {}): number[] {
  const { absolute = 0.12, relative = 3, window = 5 } = opts;
  const cuts: number[] = [];
  for (let i = 0; i < motion.length; i++) {
    const m = motion[i]!;
    if (m < absolute) continue;
    const neighbours = [...motion.slice(Math.max(0, i - window), i), ...motion.slice(i + 1, i + 1 + window)];
    if (m >= relative * median(neighbours)) cuts.push((i + 1) / sampleFps);
  }
  return cuts;
}

/** RMS level (0–1) per hop of 16-bit little-endian mono PCM. */
export function envelopeFromS16(pcm: Uint8Array, sampleRate: number, hopSec: number): number[] {
  const hop = Math.max(1, Math.round(sampleRate * hopSec));
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2));
  const samples = view.byteLength / 2;
  const out: number[] = [];
  for (let start = 0; start < samples; start += hop) {
    const end = Math.min(samples, start + hop);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const v = view.getInt16(i * 2, true) / 32768;
      sum += v * v;
    }
    out.push(Math.sqrt(sum / (end - start)));
  }
  return out;
}

/** Averages groups of `factor` hops, turning a fine envelope into a coarser one. */
export function coarsen(envelope: readonly number[], factor: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < envelope.length; i += factor) {
    const group = envelope.slice(i, i + factor);
    out.push(group.reduce((s, v) => s + v, 0) / group.length);
  }
  return out;
}

/** Value at the given percentile (0–1) of a list, used to normalise features against the clip's own range. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

export interface BeatGrid {
  bpm: number;
  /** Beat times in seconds. */
  beats: number[];
  /** 0–1: how clearly the pulse stands out from the rest of the signal. */
  confidence: number;
}

/**
 * Estimates tempo and beat positions of a music track from its level envelope: onset strength, autocorrelation for
 * the period (with sub-hop interpolation), then the phase that lines the most onsets up with the grid.
 * Use a fine envelope (≈10 ms hops) for usable tempo precision.
 */
export function estimateBeats(envelope: readonly number[], hopSec: number, opts: { minBpm?: number; maxBpm?: number } = {}): BeatGrid | undefined {
  const { minBpm = 70, maxBpm = 180 } = opts;
  if (envelope.length * hopSec < 8) return undefined;

  // Onset strength: positive level increases minus a one-second moving average, so steady loudness does not count.
  const raw = envelope.map((v, i) => Math.max(0, v - (envelope[i - 1] ?? v)));
  const w = Math.max(1, Math.round(1 / hopSec));
  const onset = raw.map((v, i) => {
    const from = Math.max(0, i - w);
    const to = Math.min(raw.length, i + w);
    let mean = 0;
    for (let k = from; k < to; k++) mean += raw[k]!;
    return Math.max(0, v - mean / (to - from));
  });
  if (onset.every((v) => v === 0)) return undefined;

  const lagMin = Math.max(2, Math.floor(60 / (maxBpm * hopSec)));
  const lagMax = Math.ceil(60 / (minBpm * hopSec));
  const corr = (lag: number) => {
    let sum = 0;
    for (let i = 0; i + lag < onset.length; i++) sum += onset[i]! * onset[i + lag]!;
    return sum;
  };
  const r0 = corr(0);
  const scores: number[] = [];
  for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) scores.push(corr(lag));

  let best = 1;
  for (let i = 1; i < scores.length - 1; i++) if (scores[i]! > scores[best]! + 1e-12) best = i;
  if (scores[best]! <= 0) return undefined;
  const [a, b, c] = [scores[best - 1]!, scores[best]!, scores[best + 1]!];
  const denom = a - 2 * b + c;
  const offset = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
  const periodHops = lagMin - 1 + best + offset;
  const period = periodHops * hopSec;

  // Phase: the offset within one period where onsets line up best.
  const steps = Math.max(1, Math.round(periodHops));
  let bestPhase = 0;
  let bestSum = -1;
  for (let s = 0; s < steps; s++) {
    const phase = (s * periodHops) / steps;
    let sum = 0;
    for (let t = phase; t < onset.length; t += periodHops) sum += onset[Math.round(t)] ?? 0;
    if (sum > bestSum) {
      bestSum = sum;
      bestPhase = phase;
    }
  }

  const duration = envelope.length * hopSec;
  const beats: number[] = [];
  for (let t = bestPhase * hopSec; t < duration; t += period) beats.push(Number(t.toFixed(4)));
  return { bpm: 60 / period, beats, confidence: Math.max(0, Math.min(1, scores[best]! / (r0 || 1))) };
}
