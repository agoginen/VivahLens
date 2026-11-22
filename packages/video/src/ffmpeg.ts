import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { runProcess, VivahError, type Preview, type ProcessRunner } from "@vivahlens/core";
import { parseFps, parseTimecode } from "./time.js";
import type { ClipInfo, MusicTrack } from "./timeline.js";

export interface FfmpegOptions {
  /** Path to the user-installed ffmpeg/ffprobe; they run as separate processes and are never bundled. */
  ffmpeg?: string;
  ffprobe?: string;
  run?: ProcessRunner;
}

const ProbeSchema = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
      r_frame_rate: z.string().optional(),
      avg_frame_rate: z.string().optional(),
      duration: z.string().optional(),
      channels: z.number().optional(),
      sample_rate: z.string().optional(),
      tags: z.record(z.string()).optional(),
    }),
  ),
  format: z.object({ duration: z.string().optional(), tags: z.record(z.string()).optional() }).optional(),
});

export interface ProbedClip extends ClipInfo {
  /** Container creation time when present; used to put clips in story order. */
  createdAt?: string;
}

const usableRate = (r: string | undefined): string | undefined => (r && r !== "0/0" && !r.startsWith("0/") ? r : undefined);

/** Thin wrapper over the user's ffmpeg: probing, tiny analysis frames, mono audio, thumbnails and proxies. */
export class Ffmpeg {
  private readonly ffmpeg: string;
  private readonly ffprobe: string;
  private readonly run: ProcessRunner;

  constructor(opts: FfmpegOptions = {}) {
    this.ffmpeg = opts.ffmpeg ?? "ffmpeg";
    this.ffprobe = opts.ffprobe ?? "ffprobe";
    this.run = opts.run ?? runProcess;
  }

  /** Version string, or null when ffmpeg is not installed. */
  async detect(): Promise<string | null> {
    const res = await this.run(this.ffmpeg, ["-version"]);
    return res.code === 0 ? (/ffmpeg version (\S+)/.exec(res.stdout)?.[1] ?? "unknown") : null;
  }

  async probe(file: string): Promise<ProbedClip> {
    const res = await this.run(this.ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
    const name = path.basename(file);
    if (res.code !== 0) throw new VivahError("ASSET_UNREADABLE", `ffprobe could not read ${name}: ${res.stderr.slice(0, 200)}`);
    let parsed: z.infer<typeof ProbeSchema>;
    try {
      parsed = ProbeSchema.parse(JSON.parse(res.stdout));
    } catch {
      throw new VivahError("ASSET_UNREADABLE", `ffprobe returned unreadable output for ${name}`);
    }
    const video = parsed.streams.find((s) => s.codec_type === "video");
    if (!video?.width || !video.height) throw new VivahError("ASSET_UNREADABLE", `${name} has no video stream`);
    const audio = parsed.streams.find((s) => s.codec_type === "audio");
    const rate = usableRate(video.avg_frame_rate) ?? usableRate(video.r_frame_rate);
    const durationSec = Number(parsed.format?.duration ?? video.duration);
    if (!rate || !Number.isFinite(durationSec) || durationSec <= 0) {
      throw new VivahError("ASSET_UNREADABLE", `Could not determine frame rate or duration of ${name}`);
    }
    const fps = parseFps(rate);
    // Cameras write the start timecode on the video stream, on a timecode data stream, or on the container.
    const timecodeTag = video.tags?.timecode ?? parsed.streams.find((s) => s.tags?.timecode)?.tags?.timecode ?? parsed.format?.tags?.timecode;
    let start: { frames: number; drop: boolean } | undefined;
    if (timecodeTag) {
      try {
        start = parseTimecode(timecodeTag, fps);
      } catch {
        // A timecode that does not fit the frame rate is not worth failing the clip for; the cut then counts from zero.
      }
    }
    return {
      clipId: name,
      path: file,
      durationSec,
      fps,
      width: video.width,
      height: video.height,
      hasAudio: !!audio,
      ...(audio?.channels && { audioChannels: audio.channels }),
      ...(audio?.sample_rate && { audioRate: Number(audio.sample_rate) }),
      ...(start && { startFrames: start.frames, startDrop: start.drop }),
      ...(parsed.format?.tags?.creation_time && { createdAt: parsed.format.tags.creation_time }),
    };
  }

  /** A music file's length and channels, for laying it under a timeline. */
  async probeAudio(file: string): Promise<MusicTrack> {
    const res = await this.run(this.ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
    const name = path.basename(file);
    if (res.code !== 0) throw new VivahError("ASSET_UNREADABLE", `ffprobe could not read ${name}: ${res.stderr.slice(0, 200)}`);
    let parsed: z.infer<typeof ProbeSchema>;
    try {
      parsed = ProbeSchema.parse(JSON.parse(res.stdout));
    } catch {
      throw new VivahError("ASSET_UNREADABLE", `ffprobe returned unreadable output for ${name}`);
    }
    const audio = parsed.streams.find((s) => s.codec_type === "audio");
    const durationSec = Number(parsed.format?.duration ?? audio?.duration);
    if (!audio || !Number.isFinite(durationSec) || durationSec <= 0) throw new VivahError("ASSET_UNREADABLE", `${name} has no audio or its length is unknown`);
    return { clipId: name, path: file, durationSec, ...(audio.channels && { channels: audio.channels }), ...(audio.sample_rate && { rate: Number(audio.sample_rate) }) };
  }

  /** Grayscale analysis frames (default 2 per second, 64×36) for motion and sharpness. */
  async sampleFrames(file: string, opts: { fps?: number; width?: number; height?: number } = {}): Promise<Uint8Array[]> {
    const { fps = 2, width = 64, height = 36 } = opts;
    const raw = await this.toTempFile("frames.raw", (out) => [
      "-v", "error", "-i", file, "-vf", `fps=${fps},scale=${width}:${height}:flags=area,format=gray`, "-f", "rawvideo", "-y", out,
    ], file);
    const size = width * height;
    const frames: Uint8Array[] = [];
    for (let o = 0; o + size <= raw.length; o += size) frames.push(raw.subarray(o, o + size));
    return frames;
  }

  /** Mono 16-bit PCM of the clip's audio, or undefined when it has none. */
  async audioPcm(file: string, rate = 8000): Promise<Uint8Array | undefined> {
    const pcm = await this.toTempFile("audio.pcm", (out) => ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-y", out], file, true);
    return pcm.length ? pcm : undefined;
  }

  /** One JPEG frame at `atSec`, for the LLM or a contact sheet. */
  async thumbnail(file: string, atSec: number, width = 640): Promise<Preview> {
    const jpg = await this.toTempFile("thumb.jpg", (out) => ["-v", "error", "-ss", String(Math.max(0, atSec)), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", "-y", out], file);
    return { mediaType: "image/jpeg", dataBase64: Buffer.from(jpg).toString("base64") };
  }

  /** Lightweight H.264 proxy for smooth editing; the originals stay untouched. */
  async proxy(file: string, outFile: string, height = 720): Promise<void> {
    const res = await this.run(this.ffmpeg, ["-v", "error", "-i", file, "-vf", `scale=-2:${height}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "96k", "-y", outFile]);
    if (res.code !== 0) throw new VivahError("ADAPTER_APPLY_FAILED", `ffmpeg proxy failed for ${path.basename(file)}: ${res.stderr.slice(0, 200)}`);
  }

  private async toTempFile(name: string, args: (out: string) => string[], source: string, allowEmpty = false): Promise<Uint8Array> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vivah-ffmpeg-"));
    try {
      const out = path.join(dir, name);
      const res = await this.run(this.ffmpeg, args(out));
      if (res.code !== 0 && !allowEmpty) {
        throw new VivahError("ASSET_UNREADABLE", `ffmpeg failed on ${path.basename(source)}: ${res.stderr.slice(0, 200)}`);
      }
      return await fs.readFile(out).catch(() => new Uint8Array(0));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}
