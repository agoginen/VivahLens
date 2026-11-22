import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProcessRunner } from "@vivahlens/core";
import { Ffmpeg } from "./ffmpeg.js";

const probeJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    streams: [
      { codec_type: "video", width: 1920, height: 1080, r_frame_rate: "30000/1001", avg_frame_rate: "30000/1001", duration: "12.5" },
      { codec_type: "audio", channels: 2, sample_rate: "48000" },
    ],
    format: { duration: "12.5", tags: { creation_time: "2026-11-20T10:00:00.000000Z" } },
    ...over,
  });

/** Records every call and writes the file the real ffmpeg would have produced (the last argument is the output path). */
function fake(handlers: { probe?: string; produce?: (args: readonly string[]) => Buffer | undefined; code?: number; stderr?: string } = {}) {
  const calls: { command: string; args: readonly string[] }[] = [];
  const run: ProcessRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === "ffprobe") return { code: handlers.code ?? 0, stdout: handlers.probe ?? probeJson(), stderr: handlers.stderr ?? "" };
    if (args.includes("-version")) return { code: 0, stdout: "ffmpeg version 7.1.1 Copyright", stderr: "" };
    const out = args.at(-1)!;
    const data = handlers.produce?.(args);
    if (data && (handlers.code ?? 0) === 0) await fs.writeFile(out, data);
    return { code: handlers.code ?? 0, stdout: "", stderr: handlers.stderr ?? "" };
  };
  return { ff: new Ffmpeg({ run }), calls };
}

describe("Ffmpeg.probe", () => {
  it("reads size, exact frame rate, duration, audio and creation time", async () => {
    const { ff, calls } = fake();
    expect(await ff.probe("C:/shoot/A001.mp4")).toMatchObject({
      clipId: "A001.mp4",
      durationSec: 12.5,
      fps: { num: 30000, den: 1001 },
      width: 1920,
      height: 1080,
      hasAudio: true,
      audioChannels: 2,
      audioRate: 48000,
      createdAt: "2026-11-20T10:00:00.000000Z",
    });
    expect(calls[0]!.command).toBe("ffprobe");
  });

  it("falls back to r_frame_rate, reports silent clips, and rejects unreadable input", async () => {
    const silent = probeJson({ streams: [{ codec_type: "video", width: 1280, height: 720, r_frame_rate: "25/1", avg_frame_rate: "0/0" }] });
    const clip = await fake({ probe: silent }).ff.probe("a.mp4");
    expect(clip.fps).toEqual({ num: 25, den: 1 });
    expect(clip.hasAudio).toBe(false);

    await expect(fake({ probe: "not json" }).ff.probe("a.mp4")).rejects.toMatchObject({ code: "ASSET_UNREADABLE" });
    await expect(fake({ code: 1, stderr: "moov atom not found" }).ff.probe("a.mp4")).rejects.toThrow(/moov atom/);
    await expect(fake({ probe: probeJson({ streams: [{ codec_type: "audio" }] }) }).ff.probe("a.mp4")).rejects.toThrow(/no video stream/);
    await expect(fake({ probe: probeJson({ streams: [{ codec_type: "video", width: 1280, height: 720, r_frame_rate: "25/1" }], format: {} }) }).ff.probe("a.mp4")).rejects.toThrow(/duration/);
    // A missing container duration falls back to the video stream's own.
    expect((await fake({ probe: probeJson({ format: {} }) }).ff.probe("a.mp4")).durationSec).toBe(12.5);
  });
});

describe("Ffmpeg outputs", () => {
  it("detects the installed version", async () => {
    expect(await fake().ff.detect()).toBe("7.1.1");
    const missing: ProcessRunner = async () => ({ code: 1, stdout: "", stderr: "" });
    expect(await new Ffmpeg({ run: missing }).detect()).toBeNull();
  });

  it("samples small grayscale frames and cleans up its temp files", async () => {
    const { ff, calls } = fake({ produce: () => Buffer.concat([Buffer.alloc(64 * 36, 1), Buffer.alloc(64 * 36, 2), Buffer.alloc(10, 9)]) });
    const frames = await ff.sampleFrames("a.mp4", { fps: 2 });
    expect(frames).toHaveLength(2);
    expect(frames[1]![0]).toBe(2);
    const args = calls[0]!.args;
    expect(args).toContain("fps=2,scale=64:36:flags=area,format=gray");
    expect(args.slice(-4, -1)).toEqual(["-f", "rawvideo", "-y"]);
    await expect(fs.access(args.at(-1)!)).rejects.toThrow();
  });

  it("returns mono PCM, or undefined when the clip has no audio track", async () => {
    const pcm = await fake({ produce: () => Buffer.alloc(16000) }).ff.audioPcm("a.mp4", 8000);
    expect(pcm).toHaveLength(16000);
    const { ff, calls } = fake({ produce: () => undefined, code: 1, stderr: "no audio" });
    expect(await ff.audioPcm("silent.mp4")).toBeUndefined();
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["-vn", "-ac", "1", "-ar", "8000", "s16le"]));
  });

  it("grabs a JPEG thumbnail with fast seek before the input", async () => {
    const { ff, calls } = fake({ produce: () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    const thumb = await ff.thumbnail("a.mp4", 3.5, 320);
    expect(Buffer.from(thumb.dataBase64, "base64")).toHaveLength(4);
    const args = calls[0]!.args;
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args).toContain("scale=320:-2");
  });

  it("surfaces ffmpeg failures with a stable error code", async () => {
    await expect(fake({ code: 1, stderr: "Invalid data found" }).ff.sampleFrames("bad.mp4")).rejects.toMatchObject({ code: "ASSET_UNREADABLE" });
    await expect(fake({ code: 1, stderr: "codec missing" }).ff.proxy("a.mp4", "out.mp4")).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED" });
  });
});
