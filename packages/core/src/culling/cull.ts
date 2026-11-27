import { clippedShare, differenceHash, hammingDistance, laplacianVariance, type GrayImage } from "./metrics.js";

export interface CullInput {
  id: string;
  image: GrayImage;
}

export type CullReason = "blurry" | "duplicate";

export interface CullResult {
  kept: string[];
  rejected: { id: string; reason: CullReason; /** For duplicates, the frame that was kept instead. */ keptInstead?: string }[];
  scores: Record<string, number>;
}

export interface CullOptions {
  /** Laplacian variance below this is rejected as blurry. */
  blurThreshold?: number;
  /**
   * Hamming distance at or below this groups frames as near-duplicates; only the sharpest of each group is kept.
   * Defaults to 0 (disabled) because the 8×8 difference hash cannot reliably distinguish burst shots from two
   * distinct photos of the same scene without timestamp information. Set to 5–10 when you know the input contains
   * rapid-fire bursts and want them deduplicated.
   */
  duplicateDistance?: number;
}

/**
 * Frames at least this fraction as sharp as the sharpest of their burst count as equally sharp: a difference that small is
 * noise in the measure, not in the photograph, so exposure decides between them. A starting point, not tuned on real bursts.
 */
const NEAR_TIE = 0.85;

type Frame = { id: string; score: number; hash: bigint; clipped: number };

/** The sharpest frame of a burst; among near-equals, the one with the least blown-out or crushed picture; then the sharper. */
function bestOfBurst(group: readonly Frame[]): Frame {
  const sharpest = Math.max(...group.map((f) => f.score));
  return group.filter((f) => f.score >= sharpest * NEAR_TIE).reduce((a, b) => (b.clipped < a.clipped || (b.clipped === a.clipped && b.score > a.score) ? b : a));
}

/** Rejects blurry frames and keeps only the best frame of each near-duplicate group. Order is preserved. */
export function cullBatch(items: readonly CullInput[], opts: CullOptions = {}): CullResult {
  const blurThreshold = opts.blurThreshold ?? 100;
  const dupDistance = opts.duplicateDistance ?? 0;

  const scores: Record<string, number> = {};
  const rejected: CullResult["rejected"] = [];
  const sharp: Frame[] = [];

  for (const item of items) {
    const score = laplacianVariance(item.image);
    scores[item.id] = score;
    if (score < blurThreshold) rejected.push({ id: item.id, reason: "blurry" });
    else sharp.push({ id: item.id, score, hash: differenceHash(item.image), clipped: clippedShare(item.image) });
  }

  const groups: Frame[][] = [];
  for (const frame of sharp) {
    const group = groups.find((g) => g.some((m) => hammingDistance(m.hash, frame.hash) <= dupDistance));
    if (group) group.push(frame);
    else groups.push([frame]);
  }

  const keptIds = new Set<string>();
  for (const group of groups) {
    const best = bestOfBurst(group);
    keptIds.add(best.id);
    for (const frame of group) {
      if (frame !== best) rejected.push({ id: frame.id, reason: "duplicate", keptInstead: best.id });
    }
  }

  return { kept: items.map((i) => i.id).filter((id) => keptIds.has(id)), rejected, scores };
}
