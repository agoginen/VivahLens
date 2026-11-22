import { describe, expect, it } from "vitest";
import { toEdl } from "./edl.js";
import { toFcpxml } from "./fcpxml.js";
import { fcpFrameDuration, fcpTime, framesToSeconds, parseFps, secondsToFrames, timecode } from "./time.js";
import { layoutTimeline, type ClipInfo, type TimelineSpec } from "./timeline.js";
import { findAll, parseXml } from "./xmlTestUtil.js";

const fps25 = parseFps(25);
const clipA: ClipInfo = { clipId: "A001.mp4", path: "/shoot/A001.mp4", durationSec: 60, fps: fps25, width: 1920, height: 1080, hasAudio: true };
const clipB: ClipInfo = { clipId: "B002.mp4", path: "/shoot/B 002 & more.mp4", durationSec: 30, fps: parseFps("29.97"), width: 3840, height: 2160, hasAudio: false };

const spec: TimelineSpec = {
  name: "Highlights <final>",
  fps: fps25,
  width: 1920,
  height: 1080,
  clips: [clipA, clipB],
  cuts: [
    { clipId: "A001.mp4", inSec: 10, outSec: 15 },
    { clipId: "B002.mp4", inSec: 3, outSec: 5.4 },
  ],
};

describe("frame rates and timecode", () => {
  it("snaps broadcast rates to exact fractions and rejects nonsense", () => {
    expect(parseFps("29.97")).toEqual({ num: 30000, den: 1001 });
    expect(parseFps(23.976)).toEqual({ num: 24000, den: 1001 });
    expect(parseFps("30000/1001")).toEqual({ num: 30000, den: 1001 });
    expect(parseFps(12)).toEqual({ num: 12000, den: 1000 });
    expect(() => parseFps("abc")).toThrow(/Invalid frame rate/);
    expect(() => parseFps(0)).toThrow();
  });

  it("converts between seconds and frames and formats timecode and FCPXML time", () => {
    expect(secondsToFrames(5.4, fps25)).toBe(135);
    expect(framesToSeconds(135, fps25)).toBeCloseTo(5.4);
    expect(timecode(135, fps25)).toBe("00:00:05:10");
    expect(timecode(3600 * 25 + 61 * 25 + 3, fps25)).toBe("01:01:01:03");
    expect(timecode(30, parseFps("29.97"))).toBe("00:00:01:00");
    expect(fcpTime(0, fps25)).toBe("0s");
    expect(fcpTime(125, fps25)).toBe("125/25s");
    expect(fcpFrameDuration(parseFps("29.97"))).toBe("1001/30000s");
    expect(fcpTime(30, parseFps("29.97"))).toBe("30030/30000s");
  });
});

describe("layoutTimeline", () => {
  it("snaps to frames, clamps cuts inside their clip, and lays them end to end", () => {
    const layout = layoutTimeline({
      ...spec,
      cuts: [
        { clipId: "A001.mp4", inSec: 58, outSec: 63 },
        { clipId: "B002.mp4", inSec: 3.013, outSec: 5.4 },
      ],
    });
    const [first, second] = layout.entries;
    expect(first).toMatchObject({ srcInFrames: 55 * 25, durFrames: 125, recInFrames: 0 });
    expect(second).toMatchObject({ srcInFrames: 75, durFrames: 60, recInFrames: 125 });
    expect(layout.totalFrames).toBe(185);
  });

  it("lays out a crossfade where the footage has spare frames around the cut, ignores one into the first clip, and warns about the rest", () => {
    const layout = layoutTimeline({ ...spec, cuts: [{ ...spec.cuts[0]!, transitionIn: "crossfade" }, { ...spec.cuts[1]!, transitionIn: "crossfade" }] });
    expect(layout.entries.map((e) => e.crossfadeFrames)).toEqual([undefined, 12]);
    expect(layout.warnings).toEqual([]);

    const noSpare = layoutTimeline({ ...spec, cuts: [{ clipId: "A001.mp4", inSec: 55, outSec: 60 }, { clipId: "B002.mp4", inSec: 0, outSec: 4, transitionIn: "crossfade" }] });
    expect(noSpare.entries.map((e) => e.crossfadeFrames)).toEqual([undefined, undefined]);
    expect(noSpare.warnings).toEqual(["There is not enough spare footage around the cut into B002.mp4 for a 12-frame crossfade; a hard cut was used."]);

    const dip = layoutTimeline({ ...spec, cuts: [spec.cuts[0]!, { ...spec.cuts[1]!, transitionIn: "dip-to-black" }] });
    expect(dip.warnings).toEqual(['Transition "dip-to-black" into B002.mp4 is not exported yet; a hard cut was used.']);
    expect(() => layoutTimeline({ ...spec, cuts: [{ clipId: "nope", inSec: 0, outSec: 1 }] })).toThrow(/unknown clip/);
  });
});

describe("toEdl", () => {
  it("writes CMX 3600 straight cuts with source/record timecode and clip names", () => {
    const { text, durationFrames } = toEdl(spec);
    expect(durationFrames).toBe(125 + 60);
    expect(text).toBe(
      [
        "TITLE: Highlights <final>",
        "FCM: NON-DROP FRAME",
        "",
        "001  A001     B     C        00:00:10:00 00:00:15:00 00:00:00:00 00:00:05:00",
        "* FROM CLIP NAME: A001.mp4",
        "002  B002     V     C        00:00:03:00 00:00:05:10 00:00:05:00 00:00:07:10",
        "* FROM CLIP NAME: B 002 & more.mp4",
        "",
      ].join("\n"),
    );
  });
});

describe("toFcpxml", () => {
  const doc = (version?: "1.10" | "1.8") => parseXml(toFcpxml(spec, { version }).text);

  it("is well-formed, escapes names, and describes the same edit as the EDL", () => {
    const root = doc();
    expect(root.name).toBe("fcpxml");
    expect(root.attrs.version).toBe("1.10");
    expect(findAll(root, "project")[0]!.attrs.name).toBe("Highlights <final>");

    const sequence = findAll(root, "sequence")[0]!;
    expect(sequence.attrs.duration).toBe("185/25s");
    const clips = findAll(root, "asset-clip");
    expect(clips.map((c) => [c.attrs.offset, c.attrs.start, c.attrs.duration])).toEqual([
      ["0s", "250/25s", "125/25s"],
      ["125/25s", "75/25s", "60/25s"],
    ]);
    // Offsets are contiguous: each clip starts where the previous one ends.
    expect(clips[1]!.attrs.offset).toBe(`${125}/25s`);
  });

  it("references real assets and gives clips with a different size or rate their own format", () => {
    const root = doc();
    const assets = findAll(root, "asset");
    const formats = findAll(root, "format");
    expect(formats).toHaveLength(2);
    expect(formats[0]!.attrs).toMatchObject({ id: "r1", frameDuration: "1/25s", width: "1920", height: "1080" });
    expect(formats[1]!.attrs).toMatchObject({ frameDuration: "1001/30000s", width: "3840", height: "2160" });

    const assetIds = new Set(assets.map((a) => a.attrs.id));
    for (const c of findAll(root, "asset-clip")) expect(assetIds.has(c.attrs.ref!)).toBe(true);
    for (const a of assets) expect(formats.some((f) => f.attrs.id === a.attrs.format)).toBe(true);

    expect(assets[0]!.attrs).toMatchObject({ hasVideo: "1", hasAudio: "1", duration: "1500/25s" });
    expect(assets[1]!.attrs.hasAudio).toBeUndefined();
  });

  it("encodes file URLs and special characters in names", () => {
    const rep = findAll(doc(), "media-rep");
    expect(rep[0]!.attrs.src).toMatch(/^file:\/\/\/.*shoot\/A001\.mp4$/);
    expect(rep[1]!.attrs.src).toContain("B%20002%20&%20more.mp4");
    expect(findAll(doc(), "asset")[1]!.attrs.name).toBe("B 002 & more");
  });

  it("writes the older src attribute for version 1.8", () => {
    const root = doc("1.8");
    expect(root.attrs.version).toBe("1.8");
    expect(findAll(root, "media-rep")).toHaveLength(0);
    expect(findAll(root, "asset")[0]!.attrs.src).toMatch(/^file:\/\/\//);
  });
});
