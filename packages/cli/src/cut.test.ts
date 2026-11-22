import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ProcessRunner } from "@vivahlens/core";
import { joinNegativeNumbers, runCli } from "./commands.js";

const root = mkdtempSync(path.join(tmpdir(), "vivah-cut-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const clips = path.join(root, "clips");
mkdirSync(clips);
// Capture order (container creation time) is c, a, b; file-name order would be a, b, c.
const created: Record<string, string> = { "a.mp4": "2026-11-20T11:00:00Z", "b.mp4": "2026-11-20T12:00:00Z", "c.mp4": "2026-11-20T10:00:00Z" };
for (const name of Object.keys(created)) writeFileSync(path.join(clips, name), "not a real video");
writeFileSync(path.join(clips, "notes.txt"), "ignored");

const RATE = 8000;

/** Stands in for ffmpeg/ffprobe: b.mp4 is lively and loud, the others calm; song.wav is a 120 BPM click track. */
const fakeRun: ProcessRunner = async (command, args) => {
  if (args.includes("-version")) return { code: 0, stdout: "ffmpeg version 7.1.1", stderr: "" };
  const file = path.basename(args[args.indexOf("-i") + 1] ?? args.at(-1)!);
  if (command === "ffprobe") {
    const name = path.basename(args.at(-1)!);
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        streams: [
          { codec_type: "video", width: 1920, height: 1080, r_frame_rate: "25/1", avg_frame_rate: "25/1", duration: "30" },
          { codec_type: "audio", channels: 2, sample_rate: "48000" },
        ],
        format: { duration: "30", tags: created[name] ? { creation_time: created[name]! } : {} },
      }),
    };
  }
  const out = args.at(-1)!;
  if (args.includes("rawvideo")) {
    const busy = file === "b.mp4" ? 25 : 2;
    const frames = Buffer.alloc(64 * 36 * 60);
    for (let f = 0; f < 60; f++) for (let i = 0; i < 64 * 36; i++) frames[f * 2304 + i] = ((i + Math.floor(i / 64)) % 2 ? 170 : 60) + (f % 2) * busy;
    await fs.writeFile(out, frames);
  } else if (args.includes("s16le")) {
    const pcm = Buffer.alloc(RATE * 2 * 30);
    const clicks = file === "song.wav";
    for (let i = 0; i < RATE * 30; i++) {
      const t = i / RATE;
      const on = clicks ? t % 0.5 < 0.04 : file === "b.mp4" || t % 5 < 0.2;
      if (on) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 1000 * i) / RATE) * (file === "b.mp4" || clicks ? 26000 : 3000)), i * 2);
    }
    await fs.writeFile(out, pcm);
  } else if (args.includes("-frames:v")) {
    await fs.writeFile(out, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
  return { code: 0, stdout: "", stderr: "" };
};

function cli(args: string[], run: ProcessRunner | undefined = fakeRun) {
  const lines: string[] = [];
  const stdout: string[] = [];
  return runCli(args, { env: { VIVAH_HOME: path.join(root, "home") }, run, log: (l) => (stdout.push(l), lines.push(l)), info: (l) => void lines.push(l) }).then((code) => ({ code, out: lines.join("\n"), stdout: stdout.join("\n") }));
}

const clipOrder = (fcpxml: string) => [...fcpxml.matchAll(/<asset-clip ref="(r\d+)"/g)].map((m) => m[1]);

describe("vivah cut", () => {
  it("builds FCPXML and EDL timelines in capture order and reports what it did", async () => {
    const out = path.join(root, "out1");
    const r = await cli(["cut", "--folder", clips, "--duration", "18", "--timeline", "both", "--name", "Reel", "--export-dir", out]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Analysing c.mp4 (1/3)");
    expect(r.stdout).toMatch(/Rough cut: \d+ cut\(s\) from 3 of 3 clip\(s\), 1\d\.\ds \(target 18s\)/);
    expect(r.stdout).toContain("Reel.fcpxml");
    expect(r.stdout).toContain("Reel.edl");

    const edl = readFileSync(path.join(out, "Reel.edl"), "utf8");
    expect(edl).toContain("TITLE: Reel");
    expect([...edl.matchAll(/\* FROM CLIP NAME: (\S+)/g)].map((m) => m[1])[0]).toBe("c.mp4");

    const xml = readFileSync(path.join(out, "Reel.fcpxml"), "utf8");
    expect(xml).toContain('<fcpxml version="1.10">');
    expect(clipOrder(xml).length).toBe([...edl.matchAll(/^\d{3} /gm)].length);
  });

  it("lets the lively, loud clip supply the most footage while every clip stays represented", async () => {
    const out = path.join(root, "out2");
    await cli(["cut", "--folder", clips, "--duration", "18", "--max-seg", "4", "--timeline", "edl", "--export-dir", out, "--name", "R2"]);
    const lines = readFileSync(path.join(out, "R2.edl"), "utf8").split("\n");
    const seconds = (tc: string) => {
      const [h, m, s, f] = tc.split(":").map(Number) as [number, number, number, number];
      return h * 3600 + m * 60 + s + f / 25;
    };
    const perClip: Record<string, number> = {};
    lines.forEach((line, i) => {
      const m = /^\d{3}\s+\S+\s+\S\s+C\s+(\S+)\s+(\S+)\s/.exec(line);
      const name = /FROM CLIP NAME: (\S+)/.exec(lines[i + 1] ?? "")?.[1];
      if (m && name) perClip[name] = (perClip[name] ?? 0) + seconds(m[2]!) - seconds(m[1]!);
    });
    expect(perClip["b.mp4"]!).toBeGreaterThan(perClip["a.mp4"] ?? 0);
    expect(perClip["b.mp4"]!).toBeGreaterThan(perClip["c.mp4"] ?? 0);
    expect(Object.keys(perClip).sort()).toEqual(["a.mp4", "b.mp4", "c.mp4"]);
  });

  it("reorders the story with the LLM when --narrative is given (mock reverses capture order)", async () => {
    const plain = path.join(root, "plain");
    const story = path.join(root, "story");
    await cli(["cut", "--folder", clips, "--duration", "18", "--timeline", "edl", "--export-dir", plain, "--name", "P"]);
    const r = await cli(["cut", "--folder", clips, "--duration", "18", "--timeline", "edl", "--export-dir", story, "--name", "S", "--narrative", "--provider", "mock"]);
    expect(r.out).toContain("to order the story");
    expect(r.out).toContain("Story order:");
    const names = (file: string) => [...readFileSync(file, "utf8").matchAll(/\* FROM CLIP NAME: (\S+)/g)].map((m) => m[1]);
    expect(names(path.join(story, "S.edl"))).toEqual([...names(path.join(plain, "P.edl"))].reverse());
  });

  it("detects the music's tempo and puts cuts on the beat", async () => {
    const song = path.join(root, "song.wav");
    writeFileSync(song, "audio");
    const r = await cli(["cut", "--folder", clips, "--duration", "18", "--music", song, "--export-dir", path.join(root, "beat"), "--name", "B"]);
    expect(r.out).toMatch(/Music: 1(19|20|21)\.\d BPM/);
    expect(r.stdout).toMatch(/\d+ on the beat/);
  });

  it("lays the music under the cut, and says when the footage has no spare frames for a crossfade instead of faking one", async () => {
    const song = path.join(root, "song2.wav");
    writeFileSync(song, "audio");
    const out = path.join(root, "extras");
    const r = await cli(["cut", "--folder", clips, "--duration", "18", "--music", song, "--music-gain", "-10", "--music-start", "2", "--crossfade", "--timeline", "both", "--export-dir", out, "--name", "X"]);
    expect(r, r.out).toMatchObject({ code: 0 });
    const xml = readFileSync(path.join(out, "X.fcpxml"), "utf8");
    expect(xml).toContain('audioRole="music"');
    expect(xml).toContain('<adjust-volume amount="-10dB">');
    expect(xml).toContain('lane="-1"');
    const edl = readFileSync(path.join(out, "X.edl"), "utf8");
    expect(edl).toMatch(/^\d{3}  SONG2 +AA +C +00:00:02:00 /m);
    // The fake footage is cut from the very start of a.mp4 and b.mp4, so there are no frames before the cut to dissolve from.
    expect(r.out).toContain("There is not enough spare footage around the cut into a.mp4 for a 12-frame crossfade; a hard cut was used.");
    expect(xml).not.toContain("<transition ");
    expect(edl).not.toMatch(/ D {4}\d{3} /);
    expect(r.out).toMatch(/note: An EDL cannot carry the music's level or fades/);
  });

  it("carries on without the music when it cannot be read, and writes drop-frame timecode only for a rate that has it", async () => {
    const unreadable: ProcessRunner = async (command, args, o) => (command === "ffprobe" && args.at(-1)?.endsWith("broken.wav") ? { code: 1, stdout: "", stderr: "Invalid data" } : fakeRun(command, args, o));
    const song = path.join(root, "broken.wav");
    writeFileSync(song, "x");
    const out = path.join(root, "nomusic");
    const r = await cli(["cut", "--folder", clips, "--duration", "12", "--music", song, "--drop-frame", "--timeline", "edl", "--export-dir", out, "--name", "N"], unreadable);
    expect(r, r.out).toMatchObject({ code: 0 });
    expect(r.out).toContain("The music was not placed on the timeline: ffprobe could not read broken.wav: Invalid data");
    expect(readFileSync(path.join(out, "N.edl"), "utf8")).not.toMatch(/ AA /);
    expect(r.out).toContain("Drop-frame timecode only exists for 29.97 and 59.94 fps; non-drop was written.");
    expect(readFileSync(path.join(out, "N.edl"), "utf8")).toContain("FCM: NON-DROP FRAME");
  });

  it("accepts a negative number after an option, which node's own parser refuses without an equals sign", () => {
    expect(joinNegativeNumbers(["cut", "--music-gain", "-10", "--duration", "18", "--x", "-1.5", "--flag", "-v", "-3"])).toEqual(["cut", "--music-gain=-10", "--duration", "18", "--x=-1.5", "--flag", "-v", "-3"]);
    expect(joinNegativeNumbers(["--music-gain=-4", "-2"])).toEqual(["--music-gain=-4", "-2"]);
  });

  it("explains missing ffmpeg, empty folders and bad options", async () => {
    const none: ProcessRunner = async () => ({ code: 1, stdout: "", stderr: "" });
    const missing = await cli(["cut", "--folder", clips], none);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("[ADAPTER_EDITOR_NOT_RUNNING]");
    expect(missing.out).toContain("ffmpeg was not found");

    const empty = path.join(root, "empty");
    mkdirSync(empty);
    expect((await cli(["cut", "--folder", empty])).out).toContain("No video files found");
    expect((await cli(["cut", "--folder", clips, "--timeline", "mp4"])).out).toContain("--timeline must be");
    expect((await cli(["cut", "--folder", clips, "--duration", "0"])).out).toContain("--duration must be");
  });

  it("skips clips ffprobe cannot read and carries on", async () => {
    const flaky: ProcessRunner = async (command, args, o) => (command === "ffprobe" && args.at(-1)!.endsWith("a.mp4") ? { code: 1, stdout: "", stderr: "moov atom not found" } : fakeRun(command, args, o));
    const r = await cli(["cut", "--folder", clips, "--duration", "12", "--export-dir", path.join(root, "flaky"), "--name", "F"], flaky);
    expect(r.code).toBe(0);
    expect(r.out).toContain("skipped a.mp4");
    expect(r.stdout).toContain("of 2 clip(s)");
  });
});
