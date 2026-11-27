import { describe, expect, it } from "vitest";
import { cullBatch } from "./cull.js";
import { clippedShare, type GrayImage } from "./metrics.js";

const SIZE = 72;

/** Deterministic noise in [-1, 1). */
const prng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 31 - 1;
};

/** Left-to-right (or reversed) brightness ramp; `noise` adds fine detail that a sharp frame has, `lift` brightens it until its bright end is blown out. */
function frame(opts: { reverse?: boolean; noise: number; seed?: number; lift?: number }): GrayImage {
  const rand = prng(opts.seed ?? 1);
  const data = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const ramp = 40 + ((opts.reverse ? SIZE - 1 - x : x) / (SIZE - 1)) * 170 + (opts.lift ?? 0);
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

  it("between burst frames that are about equally sharp, keeps the one with less blown-out picture", () => {
    const blown = frame({ noise: 70, seed: 1, lift: 70 });
    const clean = frame({ noise: 60, seed: 2 });
    const r = cullBatch([
      { id: "blown", image: blown },
      { id: "clean", image: clean },
    ]);
    // The setup: by sharpness alone the blown-out frame wins, but by less than the margin that counts as a tie.
    expect(clippedShare(blown)).toBeGreaterThan(0.1);
    expect(clippedShare(clean)).toBeLessThan(0.05);
    expect(r.scores.blown!).toBeGreaterThan(r.scores.clean!);
    expect(r.scores.clean! / r.scores.blown!).toBeGreaterThan(0.85);
    expect(r.kept).toEqual(["clean"]);
    expect(r.rejected).toEqual([{ id: "blown", reason: "duplicate", keptInstead: "clean" }]);
  });

  it("still keeps a clearly sharper burst frame when more of its picture is blown out", () => {
    const blown = frame({ noise: 110, seed: 1, lift: 40 });
    const clean = frame({ noise: 40, seed: 2 });
    // The lift clips the bright end of `blown`, shifting its hash 4 bits from `clean`; set an explicit distance so this
    // test stays meaningful even though the default is now 0 (disabled).
    const r = cullBatch([{ id: "clean", image: clean }, { id: "blown", image: blown }], { duplicateDistance: 5 });
    expect(clippedShare(blown)).toBeGreaterThan(clippedShare(clean));
    expect(r.scores.clean! / r.scores.blown!).toBeLessThan(0.85);
    expect(r.kept).toEqual(["blown"]);
    expect(r.rejected).toEqual([{ id: "clean", reason: "duplicate", keptInstead: "blown" }]);
  });
});

describe("clippedShare", () => {
  it("counts the pixels that are blown out or crushed, and no others", () => {
    const data = new Uint8Array([255, 250, 249, 128, 6, 5, 0, 100]);
    expect(clippedShare({ width: 4, height: 2, data })).toBe(4 / 8);
  });

  it("is 0 for an empty picture rather than NaN", () => {
    expect(clippedShare({ width: 0, height: 0, data: new Uint8Array(0) })).toBe(0);
  });
});
