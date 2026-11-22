import { framesToSeconds, secondsToFrames, type Fps } from "./time.js";

export interface ClipInfo {
  clipId: string;
  path: string;
  durationSec: number;
  fps: Fps;
  width: number;
  height: number;
  hasAudio: boolean;
  audioChannels?: number;
  audioRate?: number;
  /**
   * The timecode the file starts at (camera time of day, say), as a count of frames at the clip's own rate. Source
   * timecode in an EDL and the start of a clip in FCPXML are measured from it; without it they count from zero and the
   * editor cannot match the cut to the footage by timecode.
   */
  startFrames?: number;
  /** The embedded start timecode is drop-frame. */
  startDrop?: boolean;
}

export type Transition = "none" | "cut" | "crossfade" | "dip-to-black";

export interface TimelineCut {
  clipId: string;
  inSec: number;
  outSec: number;
  transitionIn?: Transition;
}

/** A music file laid under the whole timeline. */
export interface MusicTrack {
  clipId: string;
  path: string;
  durationSec: number;
  channels?: number;
  rate?: number;
  /** Where in the music file to start (a chosen section), in seconds. */
  startSec?: number;
  /** Level under the picture's own sound; default -12 dB. */
  gainDb?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
}

export interface TimelineSpec {
  name: string;
  /** Sequence frame rate and size; cut points are snapped to this frame grid. */
  fps: Fps;
  width: number;
  height: number;
  clips: readonly ClipInfo[];
  cuts: readonly TimelineCut[];
  /** How long a crossfade takes; default half a second. */
  transitionSec?: number;
  music?: MusicTrack;
  /** Write the sequence's own timecode in drop-frame form (29.97 and 59.94 only). */
  dropFrame?: boolean;
}

export interface LaidOutEntry {
  clip: ClipInfo;
  /** First source frame, last source frame (exclusive) on the sequence frame grid, counted from the start of the file. */
  srcInFrames: number;
  durFrames: number;
  /** Position on the timeline. */
  recInFrames: number;
  /** The timecode the file starts at, on the sequence frame grid (0 when unknown). */
  startFrames: number;
  /** A crossfade from the previous entry into this one, when the footage has the spare frames it needs. */
  crossfadeFrames?: number;
}

export interface LaidOutMusic {
  track: MusicTrack;
  /** First frame of the music file used, and how many frames of it play, from the start of the timeline. */
  srcInFrames: number;
  durFrames: number;
}

export interface Layout {
  entries: LaidOutEntry[];
  totalFrames: number;
  music?: LaidOutMusic;
  warnings: string[];
}

/** A crossfade is centred on the cut in FCPXML and runs forward from it in an EDL, so the outgoing clip needs the whole length and the incoming half of it. */
const DEFAULT_TRANSITION_SEC = 0.5;

/**
 * Snaps cuts to whole frames of the sequence, keeps them inside their clip, and lays them end to end.
 * Both exporters share this, so an EDL and an FCPXML of the same spec describe the same edit.
 */
export function layoutTimeline(spec: TimelineSpec): Layout {
  const byId = new Map(spec.clips.map((c) => [c.clipId, c]));
  const warnings: string[] = [];
  const entries: LaidOutEntry[] = [];
  const fade = Math.max(2, 2 * Math.round(((spec.transitionSec ?? DEFAULT_TRANSITION_SEC) * spec.fps.num) / spec.fps.den / 2));
  let rec = 0;
  for (const cut of spec.cuts) {
    const clip = byId.get(cut.clipId);
    if (!clip) throw new Error(`Cut refers to unknown clip "${cut.clipId}"`);
    const clipFrames = secondsToFrames(clip.durationSec, spec.fps);
    let dur = Math.max(1, secondsToFrames(cut.outSec - cut.inSec, spec.fps));
    dur = Math.min(dur, clipFrames);
    const src = Math.max(0, Math.min(secondsToFrames(cut.inSec, spec.fps), clipFrames - dur));
    const startFrames = clip.startFrames === undefined ? 0 : Math.round((clip.startFrames * spec.fps.num * clip.fps.den) / (clip.fps.num * spec.fps.den));
    const entry: LaidOutEntry = { clip, srcInFrames: src, durFrames: dur, recInFrames: rec, startFrames };

    const previous = entries[entries.length - 1];
    if (cut.transitionIn === "crossfade" && previous) {
      const outgoingSpare = secondsToFrames(previous.clip.durationSec, spec.fps) - (previous.srcInFrames + previous.durFrames);
      const incomingSpare = src;
      if (outgoingSpare >= fade && incomingSpare >= fade / 2 && dur > fade && previous.durFrames > fade) entry.crossfadeFrames = fade;
      else warnings.push(`There is not enough spare footage around the cut into ${clip.clipId} for a ${fade}-frame crossfade; a hard cut was used.`);
    } else if (cut.transitionIn === "dip-to-black") {
      warnings.push(`Transition "dip-to-black" into ${clip.clipId} is not exported yet; a hard cut was used.`);
    }
    entries.push(entry);
    rec += dur;
  }

  const layout: Layout = { entries, totalFrames: rec, warnings };
  if (spec.music && rec > 0) {
    const startFrames = secondsToFrames(spec.music.startSec ?? 0, spec.fps);
    const available = Math.max(0, secondsToFrames(spec.music.durationSec, spec.fps) - startFrames);
    const playing = Math.min(rec, available);
    if (playing < rec) warnings.push(`The music is ${Math.round(framesToSeconds(rec - playing, spec.fps))} s shorter than the edit; it ends before the picture does.`);
    if (playing > 0) layout.music = { track: spec.music, srcInFrames: startFrames, durFrames: playing };
  }
  layout.warnings = [...new Set(warnings)];
  return layout;
}

export const durationSeconds = (layout: Layout, fps: Fps): number => framesToSeconds(layout.totalFrames, fps);
