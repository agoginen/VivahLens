import { describe, expect, it } from "vitest";
import { coarsen, detectShotBoundaries, envelopeFromS16, estimateBeats, motionScores, percentile } from "./analysis.js";

const flat = (level: number, n = 64 * 36) => new Uint8Array(n).fill(level);

describe("motion and shot boundaries", () => {
  it("scores frame-to-frame change and finds hard cuts but not slow drift", () => {
    // 2 samples per second: shot A (6 frames, slow drift), shot B (5 frames), shot C (4 frames).
    const frames = [
      ...[40, 41, 42, 43, 44, 45].map((v) => flat(v)),
      ...[200, 200, 201, 201, 202].map((v) => flat(v)),
      ...[90, 90, 91, 91].map((v) => flat(v)),
    ];
    const motion = motionScores(frames);
    expect(motion).toHaveLength(frames.length - 1);
    expect(motion[0]).toBeCloseTo(1 / 255);
    expect(detectShotBoundaries(motion, 2)).toEqual([3, 5.5]);
  });

  it("does not mistake sustained fast action for a series of cuts", () => {
    // Every frame differs a lot from the last (a fast pan): no isolated spike, so no boundary.
    const frames = Array.from({ length: 12 }, (_, i) => flat(i % 2 ? 40 : 200));
    expect(detectShotBoundaries(motionScores(frames), 2)).toEqual([]);
  });

  it("handles empty and single-frame input", () => {
    expect(motionScores([])).toEqual([]);
    expect(motionScores([flat(10)])).toEqual([]);
    expect(detectShotBoundaries([], 2)).toEqual([]);
  });
});

describe("audio envelope", () => {
  const rate = 8000;
  const pcm = (seconds: number, burstAt: number[]) => {
    const buf = Buffer.alloc(Math.round(seconds * rate) * 2);
    for (const t of burstAt) {
      for (let i = 0; i < 0.04 * rate; i++) {
        const idx = Math.round(t * rate) + i;
        if (idx * 2 + 1 < buf.length) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 1000 * i) / rate) * 26000), idx * 2);
      }
    }
    return buf;
  };

  it("reports RMS per hop, loud where there is sound and silent elsewhere", () => {
    const env = envelopeFromS16(pcm(1, [0.5]), rate, 0.1);
    expect(env).toHaveLength(10);
    expect(env[5]).toBeGreaterThan(0.1);
    expect(env[1]).toBe(0);
  });

  it("coarsens by averaging and finds percentiles", () => {
    expect(coarsen([1, 3, 5, 7, 9], 2)).toEqual([2, 6, 9]);
    expect(percentile([5, 1, 9, 3], 0.5)).toBe(5);
    expect(percentile([], 0.9)).toBe(0);
  });

  it("estimates tempo and beat positions of a click track", () => {
    // 120 BPM clicks starting 0.13 s in, over 20 seconds.
    const beatTimes = Array.from({ length: 40 }, (_, k) => 0.13 + k * 0.5);
    const grid = estimateBeats(envelopeFromS16(pcm(20, beatTimes), rate, 0.01), 0.01)!;
    expect(grid.bpm).toBeGreaterThan(119);
    expect(grid.bpm).toBeLessThan(121);
    expect(grid.confidence).toBeGreaterThan(0.3);
    // Each detected beat lands within 30 ms of a true click.
    for (const b of grid.beats.slice(2, 30)) {
      const nearest = Math.min(...beatTimes.map((t) => Math.abs(t - b)));
      expect(nearest).toBeLessThan(0.03);
    }
  });

  it("tracks a non-integer-hop tempo (128 BPM) and returns undefined for silence or very short audio", () => {
    const period = 60 / 128;
    const beatTimes = Array.from({ length: 45 }, (_, k) => 0.2 + k * period);
    const grid = estimateBeats(envelopeFromS16(pcm(20, beatTimes), rate, 0.01), 0.01)!;
    expect(Math.abs(grid.bpm - 128)).toBeLessThan(1);

    expect(estimateBeats(envelopeFromS16(pcm(20, []), rate, 0.01), 0.01)).toBeUndefined();
    expect(estimateBeats([0.1, 0.2], 0.01)).toBeUndefined();
  });
});
