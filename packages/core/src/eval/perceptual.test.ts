import { describe, expect, it } from "vitest";
import { LOOKS_CLOSE, LOOKS_THE_SAME, summarizePerceptual, type PerceptualScore } from "./perceptual.js";

const score = (id: string, mean: number, ssim = 0.9): PerceptualScore => ({ id, deltaE: { mean, p95: mean * 2 }, ssim });

describe("summarizePerceptual", () => {
  it("averages, takes the median, and counts what looks the same and what is close", () => {
    const s = summarizePerceptual([score("a", 1, 1), score("b", 3, 0.9), score("c", 4, 0.8), score("d", 6, 0.7), score("e", 20, 0.1)]);
    expect(s.scored).toBe(5);
    expect(s.meanDeltaE).toBeCloseTo(6.8, 10);
    expect(s.medianDeltaE).toBe(4);
    expect(s.looksTheSameRate).toBeCloseTo(2 / 5, 10);
    expect(s.looksCloseRate).toBeCloseTo(4 / 5, 10);
    expect(s.meanSsim).toBeCloseTo(0.7, 10);
  });

  it("counts a photo exactly on a threshold as within it", () => {
    const s = summarizePerceptual([score("a", LOOKS_THE_SAME), score("b", LOOKS_CLOSE), score("c", LOOKS_CLOSE + 0.001)]);
    expect(s.looksTheSameRate).toBeCloseTo(1 / 3, 10);
    expect(s.looksCloseRate).toBeCloseTo(2 / 3, 10);
  });

  it("takes the middle of the two middle photos for an even count, whatever the order", () => {
    expect(summarizePerceptual([score("a", 10), score("b", 2), score("c", 4), score("d", 8)]).medianDeltaE).toBe(6);
  });

  it("says nothing, rather than NaN, when nothing was scored", () => {
    expect(summarizePerceptual([])).toEqual({ scored: 0, meanDeltaE: 0, medianDeltaE: 0, looksTheSameRate: 0, looksCloseRate: 0, meanSsim: 0 });
  });
});
