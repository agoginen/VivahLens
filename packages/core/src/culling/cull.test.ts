import { describe, expect, it } from "vitest";
import { cullBatch } from "./cull.js";
import type { GrayImage } from "./metrics.js";

const SIZE = 72;

/** Deterministic noise in [-1, 1). */
const prng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 31 - 1;
};

/** Left-to-right (or reversed) brightness ramp; `noise` adds fine detail that a sharp frame has. */
function frame(opts: { reverse?: boolean; noise: number; seed?: number }): GrayImage {
  const rand = prng(opts.seed ?? 1);
  const data = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const ramp = 40 + ((opts.reverse ? SIZE - 1 - x : x) / (SIZE - 1)) * 170;
      data[y * SIZE + x] = Math.max(0, Math.min(255, ramp + rand() * opts.noise));
    }
  }
  return { width: SIZE, height: SIZE, data };
}

describe("cullBatch", () => {
  it("rejects blurry frames", () => {
    const r = cullBatch([
      { id: "sharp", image: frame({ noise: 40 }) },
      { id: "soft", image: frame({ noise: 0 }) },
    ]);
    expect(r.kept).toEqual(["sharp"]);
    expect(r.rejected).toEqual([{ id: "soft", reason: "blurry" }]);
  });

  it("keeps only the sharpest frame of a near-duplicate burst", () => {
    const r = cullBatch([
      { id: "burst-1", image: frame({ noise: 30, seed: 1 }) },
      { id: "burst-2", image: frame({ noise: 60, seed: 2 }) },
      { id: "other", image: frame({ noise: 40, seed: 3, reverse: true }) },
    ]);
    expect(r.kept).toEqual(["burst-2", "other"]);
    expect(r.rejected).toEqual([{ id: "burst-1", reason: "duplicate", keptInstead: "burst-2" }]);
  });
});
