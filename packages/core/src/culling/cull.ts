import { differenceHash, hammingDistance, laplacianVariance, type GrayImage } from "./metrics.js";

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
  /** Hamming distance at or below this groups frames as near-duplicates. */
  duplicateDistance?: number;
}

/** Rejects blurry frames and keeps only the sharpest frame of each near-duplicate group. Order is preserved. */
export function cullBatch(items: readonly CullInput[], opts: CullOptions = {}): CullResult {
  const blurThreshold = opts.blurThreshold ?? 100;
  const dupDistance = opts.duplicateDistance ?? 6;

  const scores: Record<string, number> = {};
  const rejected: CullResult["rejected"] = [];
  const sharp: { id: string; score: number; hash: bigint }[] = [];

  for (const item of items) {
    const score = laplacianVariance(item.image);
    scores[item.id] = score;
    if (score < blurThreshold) rejected.push({ id: item.id, reason: "blurry" });
    else sharp.push({ id: item.id, score, hash: differenceHash(item.image) });
  }

  const groups: (typeof sharp)[] = [];
  for (const frame of sharp) {
    const group = groups.find((g) => g.some((m) => hammingDistance(m.hash, frame.hash) <= dupDistance));
    if (group) group.push(frame);
    else groups.push([frame]);
  }

  const keptIds = new Set<string>();
  for (const group of groups) {
    const best = group.reduce((a, b) => (b.score > a.score ? b : a));
    keptIds.add(best.id);
    for (const frame of group) {
      if (frame !== best) rejected.push({ id: frame.id, reason: "duplicate", keptInstead: best.id });
    }
  }

  return { kept: items.map((i) => i.id).filter((id) => keptIds.has(id)), rejected, scores };
}
