import path from "node:path";
import { supportsDropFrame, timecode } from "./time.js";
import { layoutTimeline, type LaidOutEntry, type TimelineSpec } from "./timeline.js";

export interface ExportedTimeline {
  text: string;
  warnings: string[];
  durationFrames: number;
}

/** CMX 3600 reel names are at most 8 upper-case alphanumerics. */
const reelName = (clipId: string): string => {
  const cleaned = path.parse(clipId).name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (cleaned || "AX").slice(0, 8).padEnd(8, " ");
};

/**
 * CMX 3600 EDL of the cut. Premiere Pro, DaVinci Resolve and most other editors import it. Source timecode counts from
 * the file's own start timecode when it is known (so the cut matches the footage by timecode) and from zero otherwise.
 * A crossfade is the usual two-line dissolve event and runs forward from the cut; Resolve reads only cross dissolves from an EDL.
 * Music is one audio-only event placed after the picture events, with no level or fades (an EDL cannot carry them).
 */
export function toEdl(spec: TimelineSpec): ExportedTimeline {
  const layout = layoutTimeline(spec);
  const warnings = [...layout.warnings];
  const drop = spec.dropFrame === true && supportsDropFrame(spec.fps);
  if (spec.dropFrame && !drop) warnings.push("Drop-frame timecode only exists for 29.97 and 59.94 fps; non-drop was written.");
  const tc = (frames: number) => timecode(frames, spec.fps, drop);
  const lines = [`TITLE: ${spec.name}`, `FCM: ${drop ? "DROP FRAME" : "NON-DROP FRAME"}`, ""];
  const mixed = layout.entries.some((e) => e.clip.startFrames !== undefined && (e.clip.startDrop ?? false) !== drop);
  if (mixed) warnings.push("Some footage starts at a timecode counted in a different (drop or non-drop) way than this EDL; its source timecode was written in the EDL's own way, so check it against the footage.");

  const track = (e: LaidOutEntry) => (e.clip.hasAudio ? "B    " : "V    ");
  const range = (e: LaidOutEntry) => [e.startFrames + e.srcInFrames, e.startFrames + e.srcInFrames + e.durFrames, e.recInFrames, e.recInFrames + e.durFrames].map(tc);
  let event = 0;
  const number = () => String(++event).padStart(3, "0");

  layout.entries.forEach((e, i) => {
    if (e.crossfadeFrames) {
      // Two lines under one number: the outgoing picture held at the cut, then the incoming clip and how long the dissolve lasts.
      const out = layout.entries[i - 1]!;
      const outPoint = tc(out.startFrames + out.srcInFrames + out.durFrames);
      const cut = tc(e.recInFrames);
      const n = number();
      lines.push(`${n}  ${reelName(out.clip.clipId)} ${track(out)} C        ${outPoint} ${outPoint} ${cut} ${cut}`);
      lines.push(`${n}  ${reelName(e.clip.clipId)} ${track(e)} D    ${String(e.crossfadeFrames).padStart(3, "0")} ${range(e).join(" ")}`);
      lines.push(`* FROM CLIP NAME: ${path.basename(out.clip.path)}`);
      lines.push(`* TO CLIP NAME: ${path.basename(e.clip.path)}`);
    } else {
      lines.push(`${number()}  ${reelName(e.clip.clipId)} ${track(e)} C        ${range(e).join(" ")}`);
      lines.push(`* FROM CLIP NAME: ${path.basename(e.clip.path)}`);
    }
  });

  if (layout.music) {
    const m = layout.music;
    const times = [m.srcInFrames, m.srcInFrames + m.durFrames, 0, m.durFrames].map(tc);
    lines.push(`${number()}  ${reelName(m.track.clipId)} AA    C        ${times.join(" ")}`);
    lines.push(`* FROM CLIP NAME: ${path.basename(m.track.path)}`);
    warnings.push("An EDL cannot carry the music's level or fades; set them in the editor. The music event comes after the picture events and starts at the beginning of the timeline.");
  }
  return { text: `${lines.join("\n")}\n`, warnings: [...new Set(warnings)], durationFrames: layout.totalFrames };
}
