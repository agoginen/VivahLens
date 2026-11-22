import { describe, expect, it } from "vitest";
import type { ProcessRunner } from "@vivahlens/core";
import { envelopeFromS16 } from "./analysis.js";
import { Ffmpeg, type ProbedClip } from "./ffmpeg.js";
import { analyzeClip, analyzeMusic, planRoughCut } from "./roughCut.js";
import type { ClipFeatures } from "./highlights.js";
import { parseFps } from "./time.js";
import { promises as fs } from "node:fs";

const fps = 2;

function features(id: string, order: number, opts: { duration: number; busy: number; loud: number; sharp?: number }): ClipFeatures {
  const frames = opts.duration * fps;
  return {
    clipId: id,
    durationSec: opts.duration,
    sampleFps: fps,
    motion: Array.from({ length: frames - 1 }, (_, i) => (i === 9 ? 0.5 : opts.busy)),
    sharpness: Array.from({ length: frames }, () => opts.sharp ?? 100),
    audio: { hopSec: 0.1, level: Array.from({ length: opts.duration * 10 }, () => opts.loud) },
    order,
  };
}

describe("planRoughCut", () => {
  const clips = [
    features("ceremony.mp4", 0, { duration: 40, busy: 0.02, loud: 0.1 }),
    features("dance.mp4", 1, { duration: 40, busy: 0.09, loud: 0.8 }),
    features("toast.mp4", 2, { duration: 40, busy: 0.04, loud: 0.4 }),
  ];

  it("favours lively footage, keeps every clip represented, lays them out in story order and hits the target", () => {
    const plan = planRoughCut(clips, { targetSec: 30 });
    expect(plan.totalSec).toBeGreaterThan(24);
    expect(plan.totalSec).toBeLessThanOrEqual(30.01);
    expect(plan.clipSeconds["dance.mp4"]!).toBeGreaterThan(plan.clipSeconds["ceremony.mp4"] ?? 0);
    expect(plan.cuts.map((c) => c.clipId)).toEqual([...plan.cuts.map((c) => c.clipId)].sort((a, b) => clips.findIndex((c) => c.clipId === a) - clips.findIndex((c) => c.clipId === b)));
    for (const c of plan.cuts) {
      const clip = clips.find((x) => x.clipId === c.clipId)!;
      expect(c.inSec).toBeGreaterThanOrEqual(0);
      expect(c.outSec).toBeLessThanOrEqual(clip.durationSec + 1e-9);
    }
    expect(plan.warnings).toEqual([]);
  });

  it("places cuts on the beats of a music grid", () => {
    const beats = Array.from({ length: 120 }, (_, k) => k * 0.5);
    const plan = planRoughCut(clips, { targetSec: 30, beats: { bpm: 120, beats, confidence: 0.9 } });
    let t = 0;
    for (const c of plan.cuts) {
      t += c.outSec - c.inSec;
      expect(beats.some((b) => Math.abs(b - t) < 1e-6)).toBe(true);
    }
    expect(plan.alignedCuts).toBe(plan.cuts.length);
  });

  it("falls back to evenly spaced samples, with a warning, when nothing scores well", () => {
    // An impossible sharpness bar drops every window, as footage that is blurry throughout would.
    const plan = planRoughCut(clips, { targetSec: 12, minSharpness: 2 });
    expect(plan.cuts.map((c) => c.clipId)).toEqual(["ceremony.mp4", "dance.mp4", "toast.mp4"]);
    expect(plan.warnings.join(" ")).toMatch(/evenly spaced/);
    for (const c of plan.cuts) expect(c.outSec - c.inSec).toBeLessThanOrEqual(4.01);
  });

  it("warns when there is much less footage than the target and handles no clips", () => {
    const plan = planRoughCut([features("short.mp4", 0, { duration: 10, busy: 0.05, loud: 0.3 })], { targetSec: 60 });
    expect(plan.warnings.join(" ")).toMatch(/Only .* of usable footage/);
    expect(planRoughCut([], { targetSec: 30 })).toMatchObject({ cuts: [], totalSec: 0 });
  });
});

describe("analyzeClip and analyzeMusic through a fake ffmpeg", () => {
  const clip: ProbedClip = { clipId: "A.mp4", path: "A.mp4", durationSec: 6, fps: parseFps(25), width: 1920, height: 1080, hasAudio: true };

  it("turns ffmpeg output into motion, sharpness and loudness features", async () => {
    // Six sampled frames: a flat frame then a checkerboard, so motion and sharpness both register.
    const flat = Buffer.alloc(64 * 36, 30);
    const checker = Buffer.alloc(64 * 36);
    for (let i = 0; i < checker.length; i++) checker[i] = (i + Math.floor(i / 64)) % 2 ? 230 : 20;
    const frames = Buffer.concat([flat, flat, checker, checker, flat, flat]);
    const pcm = Buffer.alloc(8000 * 2 * 6);
    for (let i = 0; i < 8000; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 3) * 20000), (8000 * 2 + i) * 2);

    const run: ProcessRunner = async (_cmd, args) => {
      const out = args.at(-1)!;
      await fs.writeFile(out, out.endsWith("frames.raw") ? frames : pcm);
      return { code: 0, stdout: "", stderr: "" };
    };
    const f = await analyzeClip(new Ffmpeg({ run }), clip, 3);

    expect(f).toMatchObject({ clipId: "A.mp4", order: 3, sampleFps: 2, durationSec: 6 });
    expect(f.motion).toHaveLength(5);
    expect(f.motion[1]).toBeGreaterThan(0.3);
    expect(f.motion[0]).toBe(0);
    expect(f.sharpness[2]!).toBeGreaterThan(f.sharpness[0]!);
    expect(f.audio!.level).toHaveLength(60);
    // The tone plays from 2.0 s to 3.0 s (hops 20–29); the rest is silent.
    expect(f.audio!.level[25]!).toBeGreaterThan(0.2);
    expect(f.audio!.level[15]).toBe(0);
  });

  it("skips audio analysis for silent clips and finds a tempo in a music file", async () => {
    const silent = await analyzeClip(new Ffmpeg({ run: async (_c, args) => (await fs.writeFile(args.at(-1)!, Buffer.alloc(64 * 36 * 4, 5)), { code: 0, stdout: "", stderr: "" }) }), { ...clip, hasAudio: false }, 0);
    expect(silent.audio).toBeUndefined();

    const rate = 8000;
    const music = Buffer.alloc(20 * rate * 2);
    for (let k = 0; k < 40; k++) for (let i = 0; i < 0.04 * rate; i++) music.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 1000 * i) / rate) * 26000), (Math.round((0.1 + k * 0.5) * rate) + i) * 2);
    const grid = await analyzeMusic(new Ffmpeg({ run: async (_c, args) => (await fs.writeFile(args.at(-1)!, music), { code: 0, stdout: "", stderr: "" }) }), "song.mp3");
    expect(Math.abs(grid!.bpm - 120)).toBeLessThan(1);
    expect(envelopeFromS16(music, rate, 0.01).length).toBeGreaterThan(1000);
  });
});
