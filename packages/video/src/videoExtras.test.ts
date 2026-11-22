import { describe, expect, it } from "vitest";
import type { ProcessRunner } from "@vivahlens/core";
import { toEdl } from "./edl.js";
import { toFcpxml } from "./fcpxml.js";
import { Ffmpeg } from "./ffmpeg.js";
import { parseFps, parseTimecode, supportsDropFrame, timecode } from "./time.js";
import { layoutTimeline, type ClipInfo, type MusicTrack, type TimelineSpec } from "./timeline.js";
import { findAll, parseXml } from "./xmlTestUtil.js";

const ntsc = parseFps("29.97");
const pal = parseFps(25);

describe("drop-frame timecode", () => {
  it("agrees with the standard on the values everyone knows", () => {
    expect(timecode(1799, ntsc, true)).toBe("00:00:59;29");
    expect(timecode(1800, ntsc, true)).toBe("00:01:00;02");
    expect(timecode(17981, ntsc, true)).toBe("00:09:59;29");
    expect(timecode(17982, ntsc, true)).toBe("00:10:00;00");
    expect(timecode(107892, ntsc, true)).toBe("01:00:00;00");
    expect(timecode(1800, ntsc, false)).toBe("00:01:00:00");
    expect(timecode(3597, parseFps("59.94"), true)).toBe("00:00:59;57");
    expect(timecode(3600, parseFps("59.94"), true)).toBe("00:01:00;04");
  });

  it("parses what it writes, for every frame of the first hours, in both modes", () => {
    for (const drop of [false, true]) {
      for (let frames = 0; frames < 3 * 107892; frames += 97) expect(parseTimecode(timecode(frames, ntsc, drop), ntsc), `${drop} ${frames}`).toEqual({ frames, drop });
    }
    expect(parseTimecode("00:01:00;02", ntsc)).toEqual({ frames: 1800, drop: true });
    expect(parseTimecode("00:01:00.02", ntsc)).toEqual({ frames: 1800, drop: true });
    expect(parseTimecode("10:00:00:00", pal)).toEqual({ frames: 900_000, drop: false });
  });

  it("refuses timecode that cannot exist", () => {
    expect(() => timecode(10, pal, true)).toThrow(/only exists for 29.97/);
    expect(() => parseTimecode("00:01:00;02", pal)).toThrow(/does not fit/);
    expect(() => parseTimecode("00:00:00:30", ntsc)).toThrow(/out of range/);
    expect(() => parseTimecode("00:61:00:00", pal)).toThrow(/out of range/);
    expect(() => parseTimecode("soon", pal)).toThrow(/Bad timecode/);
    expect([supportsDropFrame(ntsc), supportsDropFrame(parseFps("59.94")), supportsDropFrame(pal), supportsDropFrame(parseFps(30))]).toEqual([true, true, false, false]);
  });
});

describe("start timecode from ffprobe", () => {
  const probe = (video: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    new Ffmpeg({
      run: (async () => ({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ streams: [{ codec_type: "video", width: 1920, height: 1080, r_frame_rate: "30000/1001", avg_frame_rate: "30000/1001", ...video }], format: { duration: "10", ...extra } }),
      })) as ProcessRunner,
    }).probe("a.mov");

  it("reads it from the video stream, from a timecode data stream, or from the container, in that order of preference", async () => {
    expect(await probe({ tags: { timecode: "01:00:00;00" } })).toMatchObject({ startFrames: 107892, startDrop: true });
    const data = new Ffmpeg({
      run: (async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ streams: [{ codec_type: "video", width: 1, height: 1, r_frame_rate: "25/1", avg_frame_rate: "25/1" }, { codec_type: "data", tags: { timecode: "10:00:00:00" } }], format: { duration: "10" } }) })) as ProcessRunner,
    });
    expect(await data.probe("a.mov")).toMatchObject({ startFrames: 900_000, startDrop: false });
    expect(await probe({}, { tags: { timecode: "00:00:10:00" } })).toMatchObject({ startFrames: 300, startDrop: false });
    expect(await probe({ tags: { timecode: "00:00:20:00" } }, { tags: { timecode: "00:00:10:00" } })).toMatchObject({ startFrames: 600 });
  });

  it("leaves the start out when there is none or it does not fit the frame rate, rather than failing the clip", async () => {
    expect(await probe({})).not.toHaveProperty("startFrames");
    expect(await probe({ tags: { timecode: "nonsense" } })).not.toHaveProperty("startFrames");
    expect(await probe({ tags: { timecode: "00:00:00:45" } })).not.toHaveProperty("startFrames");
  });
});

const clip = (id: string, over: Partial<ClipInfo> = {}): ClipInfo => ({ clipId: id, path: `/shoot/${id}`, durationSec: 60, fps: pal, width: 1920, height: 1080, hasAudio: true, ...over });
const song: MusicTrack = { clipId: "song.mp3", path: "/music/First Dance.mp3", durationSec: 200, startSec: 4, gainDb: -14, fadeInSec: 2, fadeOutSec: 4 };
const base = (over: Partial<TimelineSpec> = {}): TimelineSpec => ({
  name: "Reel",
  fps: pal,
  width: 1920,
  height: 1080,
  clips: [clip("A.mov"), clip("B.mov")],
  cuts: [{ clipId: "A.mov", inSec: 10, outSec: 15 }, { clipId: "B.mov", inSec: 20, outSec: 24, transitionIn: "crossfade" }],
  ...over,
});

describe("layout with start timecode and music", () => {
  it("measures a clip's start timecode on the sequence's frame grid, whatever rate the clip was shot at", () => {
    const layout = layoutTimeline(base({ clips: [clip("A.mov", { startFrames: 900_000 }), clip("B.mov", { fps: parseFps(50), startFrames: 100 })] }));
    expect(layout.entries.map((e) => e.startFrames)).toEqual([900_000, 50]);
  });

  it("puts the music under the whole edit, starting where asked, and says when it runs out", () => {
    const layout = layoutTimeline(base({ music: song }));
    expect(layout.music).toMatchObject({ srcInFrames: 100, durFrames: 225 });
    expect(layout.warnings).toEqual([]);
    const short = layoutTimeline(base({ music: { ...song, durationSec: 6 } }));
    expect(short.music).toMatchObject({ srcInFrames: 100, durFrames: 50 });
    expect(short.warnings).toEqual(["The music is 7 s shorter than the edit; it ends before the picture does."]);
    expect(layoutTimeline(base({ music: { ...song, startSec: 300 } })).music).toBeUndefined();
  });
});

describe("EDL with the extras", () => {
  it("counts source timecode from the footage's own start, and writes drop-frame when asked", () => {
    const text = toEdl(base({ fps: ntsc, clips: [clip("A.mov", { fps: ntsc, startFrames: 107892, startDrop: true }), clip("B.mov", { fps: ntsc })], cuts: [{ clipId: "A.mov", inSec: 10, outSec: 15 }], dropFrame: true })).text;
    expect(text).toContain("FCM: DROP FRAME");
    expect(text).toMatch(/001  A        B     C        01:00:10;00 01:00:15;00 00:00:00;00 00:00:05;00/);
  });

  it("writes a crossfade as the standard two-line dissolve event, with the clip names, and no separate event for the incoming clip", () => {
    const { text } = toEdl(base());
    expect(text.split("\n")).toEqual([
      "TITLE: Reel",
      "FCM: NON-DROP FRAME",
      "",
      "001  A        B     C        00:00:10:00 00:00:15:00 00:00:00:00 00:00:05:00",
      "* FROM CLIP NAME: A.mov",
      "002  A        B     C        00:00:15:00 00:00:15:00 00:00:05:00 00:00:05:00",
      "002  B        B     D    012 00:00:20:00 00:00:24:00 00:00:05:00 00:00:09:00",
      "* FROM CLIP NAME: A.mov",
      "* TO CLIP NAME: B.mov",
      "",
    ]);
  });

  it("writes the music as an audio event and warns that an EDL cannot hold its level or fades", () => {
    const { text, warnings } = toEdl(base({ music: song, cuts: [{ clipId: "A.mov", inSec: 10, outSec: 15 }] }));
    expect(text).toMatch(/002  SONG +AA +C +00:00:04:00 00:00:09:00 00:00:00:00 00:00:05:00\n\* FROM CLIP NAME: First Dance\.mp3/);
    expect(warnings).toEqual([expect.stringContaining("cannot carry the music's level or fades")]);
  });

  it("warns when footage starts at a timecode counted the other way, and when drop-frame is asked for at a rate that has none", () => {
    const mixed = toEdl(base({ fps: ntsc, clips: [clip("A.mov", { fps: ntsc, startFrames: 1800, startDrop: true })], cuts: [{ clipId: "A.mov", inSec: 1, outSec: 2 }] }));
    expect(mixed.warnings).toEqual([expect.stringContaining("different (drop or non-drop)")]);
    expect(toEdl(base({ dropFrame: true })).warnings).toContain("Drop-frame timecode only exists for 29.97 and 59.94 fps; non-drop was written.");
  });
});

describe("FCPXML with the extras", () => {
  const xml = (spec: TimelineSpec) => parseXml(toFcpxml(spec).text);

  it("puts a Cross Dissolve between the clips, centred on the cut, pointing at its effect", () => {
    const root = xml(base());
    const effect = findAll(root, "effect")[0]!;
    expect(effect.attrs).toMatchObject({ name: "Cross Dissolve", uid: "FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265" });
    const spine = findAll(root, "spine")[0]!;
    expect(spine.children.map((c) => c.name)).toEqual(["asset-clip", "transition", "asset-clip"]);
    const transition = spine.children[1]!;
    expect(transition.attrs).toMatchObject({ name: "Cross Dissolve", offset: "119/25s", duration: "12/25s" });
    expect(transition.children[0]!.attrs.ref).toBe(effect.attrs.id);
    // The clips themselves stay where they were: the transition overlaps their ends rather than moving them.
    expect(findAll(root, "asset-clip").map((c) => c.attrs.offset)).toEqual(["0s", "125/25s"]);
    expect(toFcpxml(base()).warnings).toEqual([expect.stringContaining("Cross Dissolve")]);
  });

  it("starts each clip from the footage's start timecode plus where the cut begins", () => {
    const root = xml(base({ clips: [clip("A.mov", { startFrames: 900_000 }), clip("B.mov")] }));
    const assets = findAll(root, "asset");
    expect(assets[0]!.attrs.start).toBe("900000/25s");
    expect(assets[1]!.attrs.start).toBe("0s");
    expect(findAll(root, "asset-clip").map((c) => c.attrs.start)).toEqual(["900250/25s", "500/25s"]);
  });

  it("anchors the music under the first clip with its role, level and fades", () => {
    const root = xml(base({ music: song, clips: [clip("A.mov", { startFrames: 900_000 }), clip("B.mov")] }));
    const spine = findAll(root, "spine")[0]!;
    const first = spine.children[0]!;
    const music = first.children[0]!;
    expect(music.name).toBe("asset-clip");
    expect(music.attrs).toMatchObject({ lane: "-1", offset: first.attrs.start, start: "100/25s", duration: "225/25s", audioRole: "music" });
    const volume = findAll(music, "adjust-volume")[0]!;
    expect(volume.attrs.amount).toBe("-14dB");
    expect(findAll(volume, "fadeIn")[0]!.attrs).toMatchObject({ type: "easeIn", duration: "50/25s" });
    expect(findAll(volume, "fadeOut")[0]!.attrs).toMatchObject({ type: "easeOut", duration: "100/25s" });
    const asset = findAll(root, "asset").find((a) => a.attrs.id === music.attrs.ref)!;
    expect(asset.attrs).toMatchObject({ name: "First Dance", hasAudio: "1", start: "0s", duration: "5000/25s" });
    expect(asset.attrs.hasVideo).toBeUndefined();
    expect(toFcpxml(base({ music: song })).warnings).toEqual(expect.arrayContaining([expect.stringContaining("have not been tried in Final Cut Pro")]));
  });

  it("leaves out fades that are set to zero, writes the older src form for 1.8, and marks drop-frame sequences", () => {
    const root = xml(base({ music: { ...song, fadeInSec: 0, fadeOutSec: 0 } }));
    expect(findAll(root, "fadeIn")).toHaveLength(0);
    expect(findAll(root, "param")).toHaveLength(0);
    const old = parseXml(toFcpxml(base({ music: song }), { version: "1.8" }).text);
    expect(findAll(old, "media-rep")).toHaveLength(0);
    expect(findAll(old, "asset").every((a) => a.attrs.src?.startsWith("file:///"))).toBe(true);
    expect(findAll(xml(base({ fps: ntsc, clips: [clip("A.mov", { fps: ntsc }), clip("B.mov", { fps: ntsc })], dropFrame: true })), "sequence")[0]!.attrs.tcFormat).toBe("DF");
    expect(findAll(xml(base()), "sequence")[0]!.attrs.tcFormat).toBe("NDF");
  });

  it("makes no transition where the footage has no spare frames", () => {
    const root = xml(base({ cuts: [{ clipId: "A.mov", inSec: 55, outSec: 60 }, { clipId: "B.mov", inSec: 0, outSec: 4, transitionIn: "crossfade" }] }));
    expect(findAll(root, "transition")).toHaveLength(0);
    expect(findAll(root, "effect")).toHaveLength(0);
  });
});
