/** How close a proposed edit looks to the photographer's own on one photo, measured on the two pictures rather than on the sliders. */
export interface PerceptualScore {
  id: string;
  /** CIEDE2000 colour difference between the two pictures: the mean over the pixels and the 95th percentile. */
  deltaE: { mean: number; p95: number };
  /** Structural similarity of their lightness, 1 for identical. */
  ssim: number;
}

/** A mean colour difference at or below which two pictures look the same at a glance (a starting point, not a measured standard). */
export const LOOKS_THE_SAME = 3;
/** A mean colour difference at or below which two pictures are still clearly the same look, with a visible difference. */
export const LOOKS_CLOSE = 6;

export interface PerceptualSummary {
  scored: number;
  meanDeltaE: number;
  medianDeltaE: number;
  /** The share of photos whose mean colour difference is within `LOOKS_THE_SAME`, and within `LOOKS_CLOSE`. */
  looksTheSameRate: number;
  looksCloseRate: number;
  meanSsim: number;
}

/** Sums up per-photo scores. Two edits can look alike with different sliders, and this is the measure that sees it (plan §7.5). */
export function summarizePerceptual(scores: readonly PerceptualScore[]): PerceptualSummary {
  const n = scores.length;
  if (n === 0) return { scored: 0, meanDeltaE: 0, medianDeltaE: 0, looksTheSameRate: 0, looksCloseRate: 0, meanSsim: 0 };
  const means = scores.map((s) => s.deltaE.mean).sort((a, b) => a - b);
  const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);
  return {
    scored: n,
    meanDeltaE: sum(means) / n,
    medianDeltaE: n % 2 ? means[(n - 1) / 2]! : (means[n / 2 - 1]! + means[n / 2]!) / 2,
    looksTheSameRate: means.filter((m) => m <= LOOKS_THE_SAME).length / n,
    looksCloseRate: means.filter((m) => m <= LOOKS_CLOSE).length / n,
    meanSsim: sum(scores.map((s) => s.ssim)) / n,
  };
}
