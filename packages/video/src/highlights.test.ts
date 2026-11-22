import { describe, expect, it } from "vitest";
import { alignToBeats, buildSegments, fitToTarget, selectHighlights, shootReferences, type ClipFeatures, type Segment } from "./highlights.js";

const fps = 2;

/** A clip with two shots split at `cutAt`; each shot has its own activity level. */
function clip(id: string, order: number, opts: { duration: number; cutAt?: number; busy?: number; quiet?: number; sharp?: (t: number) => number; loud?: (t: number) => number }): ClipFeatures {
  const frames = Math.floor(opts.duration * fps);
  const motion = Array.from({ length: frames - 1 }, (_, i) => {
    const t = (i + 1) / fps;
    if (opts.cutAt !== undefined && Math.abs(t - opts.cutAt) < 1e-9) return 0.5;
    return opts.cutAt !== undefined && t > opts.cutAt ? (opts.quiet ?? 0.01) : (opts.busy ?? 0.06);
  });
  const sharpness = Array.from({ length: frames }, (_, i) => (opts.sharp ? opts.sharp(i / fps) : 100));
  const level = Array.from({ length: Math.floor(opts.duration / 0.1) }, (_, i) => (opts.loud ? opts.loud(i * 0.1) : 0.2));
  return { clipId: id, durationSec: opts.duration, sampleFps: fps, motion, sharpness, audio: { hopSec: 0.1, level }, order };
}

describe("buildSegments", () => {
  it("splits at shot boundaries into windows no longer than the maximum and ranks lively footage higher", () => {
    const c = clip("a", 0, { duration: 20, cutAt: 10, busy: 0.08, quiet: 0.005, loud: (t) => (t < 10 ? 0.8 : 0.05) });
    const segs = buildSegments(c, { minSegSec: 2, maxSegSec: 8 });
    expect(segs).toHaveLength(4);
    expect(segs.map((s) => [s.inSec, s.outSec])).toEqual([[0, 5], [5, 10], [10, 15], [15, 20]]);
    expect(Math.min(segs[0]!.score, segs[1]!.score)).toBeGreaterThan(Math.max(segs[2]!.score, segs[3]!.score));
  });

  it("drops blurry windows and shots shorter than the minimum", () => {
    const blurryMiddle = clip("b", 0, { duration: 20, cutAt: 10, sharp: (t) => (t >= 10 ? 3 : 100) });
    expect(buildSegments(blurryMiddle).every((s) => s.outSec <= 10)).toBe(true);

    const short = clip("c", 0, { duration: 6, cutAt: 1 });
    expect(buildSegments(short, { minSegSec: 2 }).map((s) => [s.inSec, s.outSec])).toEqual([[1, 6]]);
  });

  it("scores from motion and sharpness alone when the clip has no audio", () => {
    const silent = { ...clip("d", 0, { duration: 8 }), audio: undefined };
    const [seg] = buildSegments(silent);
    expect(seg!.score).toBeGreaterThan(0);
    expect(seg!.score).toBeLessThanOrEqual(1);
  });

  it("compares clips with each other by default, so a calm clip does not score like a lively one", () => {
    const calm = clip("calm", 0, { duration: 10, busy: 0.01, loud: () => 0.05 });
    const lively = clip("lively", 1, { duration: 10, busy: 0.09, loud: () => 0.8 });
    const references = shootReferences([calm, lively]);

    // Judged only against its own clip, the calm clip looks as good as the lively one.
    const local = (c: ClipFeatures) => buildSegments(c, { references, globalWeight: 0 })[0]!.score;
    expect(local(calm)).toBeCloseTo(local(lively), 1);

    // Blended with the whole shoot, lively footage ranks clearly higher.
    const blended = (c: ClipFeatures) => buildSegments(c, { references })[0]!.score;
    expect(blended(lively)).toBeGreaterThan(blended(calm) + 0.2);
    // Without shoot references (a single clip) the blend has nothing to compare against and behaves as local.
    expect(buildSegments(calm)[0]!.score).toBeCloseTo(local(calm), 5);
  });
});

const seg = (clipId: string, order: number, inSec: number, score: number, len = 6): Segment => ({ clipId, order, inSec, outSec: inSec + len, score });

describe("selectHighlights", () => {
  it("covers the target with the best windows, caps any one clip's share, and returns story order", () => {
    const segments = [
      ...Array.from({ length: 10 }, (_, i) => seg("A", 0, i * 6, 0.9 - i * 0.01)),
      seg("B", 1, 0, 0.5),
      seg("B", 1, 6, 0.45),
      seg("C", 2, 0, 0.4),
      seg("C", 2, 6, 0.35),
    ];
    const picks = selectHighlights(segments, { targetSec: 30, maxSegSec: 6, maxClipShare: 0.5 });

    const length = (c: string) => picks.filter((p) => p.clipId === c).reduce((s, p) => s + (p.availableOut - p.availableIn), 0);
    expect(picks.reduce((s, p) => s + (p.availableOut - p.availableIn), 0)).toBeGreaterThanOrEqual(30);
    expect(length("A")).toBeLessThanOrEqual(0.5 * 30 * 1.15 + 1e-9);
    expect(picks.some((p) => p.clipId === "B")).toBe(true);
    expect(picks.map((p) => p.order)).toEqual([...picks.map((p) => p.order)].sort((a, b) => a - b));
  });

  it("relaxes the share cap when there is only one clip", () => {
    const only = Array.from({ length: 6 }, (_, i) => seg("A", 0, i * 6, 0.5));
    const picks = selectHighlights(only, { targetSec: 24, maxSegSec: 6, maxClipShare: 0.3 });
    expect(picks.length).toBeGreaterThanOrEqual(4);
  });

  it("returns nothing when there is no footage", () => {
    expect(selectHighlights([], { targetSec: 30 })).toEqual([]);
  });
});

describe("fitToTarget", () => {
  const picks = [
    { clipId: "A", availableIn: 0, availableOut: 8, score: 0.9, order: 0 },
    { clipId: "B", availableIn: 0, availableOut: 8, score: 0.2, order: 1 },
    { clipId: "C", availableIn: 0, availableOut: 8, score: 0.5, order: 2 },
  ];
  const total = (cuts: { inSec: number; outSec: number }[]) => cuts.reduce((s, c) => s + c.outSec - c.inSec, 0);

  it("shortens the weakest windows first and keeps story order", () => {
    const cuts = fitToTarget(picks, { targetSec: 20, minSegSec: 2, maxSegSec: 8 });
    expect(total(cuts)).toBeCloseTo(20);
    expect(cuts.map((c) => c.clipId)).toEqual(["A", "B", "C"]);
    expect(cuts[0]!.outSec - cuts[0]!.inSec).toBeCloseTo(8);
    expect(cuts[1]!.outSec - cuts[1]!.inSec).toBeCloseTo(4);
  });

  it("drops the weakest windows when even the minimum lengths overshoot, and never extends short windows", () => {
    const cuts = fitToTarget(picks, { targetSec: 5, minSegSec: 2, maxSegSec: 8 });
    expect(total(cuts)).toBeLessThanOrEqual(6.01);
    expect(cuts.some((c) => c.clipId === "B")).toBe(false);

    const tiny = fitToTarget([{ clipId: "T", availableIn: 3, availableOut: 4.5, score: 0.1, order: 0 }, ...picks], { targetSec: 12, minSegSec: 2, maxSegSec: 8 });
    expect(tiny.find((c) => c.clipId === "T")!.outSec - tiny.find((c) => c.clipId === "T")!.inSec).toBeLessThanOrEqual(1.5 + 1e-9);
  });

  it("keeps footage inside each window's available range", () => {
    for (const c of fitToTarget(picks, { targetSec: 12 })) {
      const p = picks.find((x) => x.clipId === c.clipId)!;
      expect(c.inSec).toBeGreaterThanOrEqual(p.availableIn - 1e-9);
      expect(c.outSec).toBeLessThanOrEqual(p.availableOut + 1e-9);
    }
  });
});

describe("alignToBeats", () => {
  const beats = Array.from({ length: 80 }, (_, k) => k * 0.5); // 120 BPM from t=0
  const pick = (i: number, len: number) => ({ clipId: `c${i}`, availableIn: 10, availableOut: 10 + len, score: 0.5, order: i });

  it("ends every cut on a beat and prefers bar lines when one is close enough", () => {
    const { cuts, alignedCuts } = alignToBeats([pick(0, 6), pick(1, 6), pick(2, 6), pick(3, 6)], beats, { targetSec: 20, minSegSec: 2, maxSegSec: 6 });
    expect(alignedCuts).toBe(cuts.length);
    let t = 0;
    for (const c of cuts) {
      t += c.outSec - c.inSec;
      expect(beats.some((b) => Math.abs(b - t) < 1e-6)).toBe(true);
    }
    expect(cuts.map((c) => c.outSec - c.inSec)).toEqual([6, 6, 6, 2].slice(0, cuts.length));
  });

  it("takes the longest beat that fits when no bar line is near, and stops near the target", () => {
    const { cuts } = alignToBeats([pick(0, 5.3), pick(1, 5.3), pick(2, 5.3), pick(3, 5.3), pick(4, 5.3)], beats, { targetSec: 14, minSegSec: 2, maxSegSec: 8 });
    const total = cuts.reduce((s, c) => s + c.outSec - c.inSec, 0);
    expect(total).toBeGreaterThanOrEqual(13.5);
    expect(total).toBeLessThanOrEqual(14.5);
  });

  it("leaves a cut unaligned when beats are too sparse for its footage, and falls back without a beat grid", () => {
    const sparse = [0, 10, 20];
    const r = alignToBeats([pick(0, 4)], sparse, { targetSec: 4, minSegSec: 2, maxSegSec: 8 });
    expect(r.alignedCuts).toBe(0);
    expect(r.cuts).toHaveLength(1);

    const none = alignToBeats([pick(0, 6), pick(1, 6)], [], { targetSec: 8 });
    expect(none.alignedCuts).toBe(0);
    expect(none.cuts.reduce((s, c) => s + c.outSec - c.inSec, 0)).toBeCloseTo(8);
  });
});
