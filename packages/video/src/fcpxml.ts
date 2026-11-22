import path from "node:path";
import { pathToFileURL } from "node:url";
import { fcpFrameDuration, fcpTime, secondsToFrames, supportsDropFrame, type Fps } from "./time.js";
import { layoutTimeline, type ClipInfo, type TimelineSpec } from "./timeline.js";
import type { ExportedTimeline } from "./edl.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface FcpxmlOptions {
  /**
   * "1.10" (Apple's currently published reference) writes `media-rep`; "1.8" writes the older `src` attribute for
   * maximum compatibility. Neither has been imported into a real Final Cut Pro yet: target the DTD of the installed version.
   */
  version?: "1.10" | "1.8";
}

const sameFormat = (c: ClipInfo, spec: TimelineSpec) =>
  c.width === spec.width && c.height === spec.height && c.fps.num * spec.fps.den === spec.fps.num * c.fps.den;

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));

/** A sum of times given as frames at two rates, as FCPXML rational time (kept in frames of that rate when both rates are the same). */
function sumTime(a: { frames: number; fps: Fps }, b: { frames: number; fps: Fps }): string {
  if (a.frames === 0) return fcpTime(b.frames, b.fps);
  if (a.fps.num === b.fps.num && a.fps.den === b.fps.den) return fcpTime(a.frames + b.frames, b.fps);
  const num = a.frames * a.fps.den * b.fps.num + b.frames * b.fps.den * a.fps.num;
  const den = a.fps.num * b.fps.num;
  if (num === 0) return "0s";
  const g = gcd(num, den);
  return den / g === 1 ? `${num / g}s` : `${num / g}/${den / g}s`;
}

/** Apple's built-in Cross Dissolve. The uid is not in Apple's documentation: it is the value other FCPXML writers use for it (see docs/research). */
const CROSS_DISSOLVE_UID = "FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265";

/**
 * FCPXML of the cut for Final Cut Pro. DaVinci Resolve also imports FCPXML (MediaPool.ImportTimelineFromFile).
 * Crossfades are Cross Dissolve transitions centred on the cut; music is a connected clip under the first picture clip,
 * with its level and fades; footage that carries a start timecode keeps it. None of this has been imported into a real Final Cut Pro yet.
 */
export function toFcpxml(spec: TimelineSpec, opts: FcpxmlOptions = {}): ExportedTimeline {
  const version = opts.version ?? "1.10";
  const layout = layoutTimeline(spec);
  const warnings = [...layout.warnings];
  const used = [...new Map(layout.entries.map((e) => [e.clip.clipId, e.clip])).values()];
  const drop = spec.dropFrame === true && supportsDropFrame(spec.fps);
  if (spec.dropFrame && !drop) warnings.push("Drop-frame timecode only exists for 29.97 and 59.94 fps; non-drop was written.");

  let nextId = 2;
  const seqFormat = "r1";
  const resources: string[] = [`    <format id="${seqFormat}" frameDuration="${fcpFrameDuration(spec.fps)}" width="${spec.width}" height="${spec.height}"/>`];
  const assetIds = new Map<string, string>();

  for (const clip of used) {
    let format = seqFormat;
    if (!sameFormat(clip, spec)) {
      format = `r${nextId++}`;
      resources.push(`    <format id="${format}" frameDuration="${fcpFrameDuration(clip.fps)}" width="${clip.width}" height="${clip.height}"/>`);
    }
    const id = `r${nextId++}`;
    assetIds.set(clip.clipId, id);
    const src = pathToFileURL(path.resolve(clip.path)).href;
    const duration = fcpTime(secondsToFrames(clip.durationSec, clip.fps), clip.fps);
    const audio = clip.hasAudio ? ` hasAudio="1" audioSources="1" audioChannels="${clip.audioChannels ?? 2}" audioRate="${clip.audioRate ?? 48000}"` : "";
    const attrs = `id="${id}" name="${esc(path.parse(clip.path).name)}" start="${fcpTime(clip.startFrames ?? 0, clip.fps)}" duration="${duration}" hasVideo="1" format="${format}"${audio}`;
    resources.push(
      version === "1.10"
        ? `    <asset ${attrs}>\n      <media-rep kind="original-media" src="${esc(src)}"/>\n    </asset>`
        : `    <asset ${attrs} src="${esc(src)}"/>`,
    );
  }

  const music = layout.music;
  let musicId = "";
  if (music) {
    musicId = `r${nextId++}`;
    const track = music.track;
    const src = pathToFileURL(path.resolve(track.path)).href;
    const attrs = `id="${musicId}" name="${esc(path.parse(track.path).name)}" start="0s" duration="${fcpTime(secondsToFrames(track.durationSec, spec.fps), spec.fps)}" hasAudio="1" audioSources="1" audioChannels="${track.channels ?? 2}" audioRate="${track.rate ?? 48000}"`;
    resources.push(
      version === "1.10"
        ? `    <asset ${attrs}>\n      <media-rep kind="original-media" src="${esc(src)}"/>\n    </asset>`
        : `    <asset ${attrs} src="${esc(src)}"/>`,
    );
  }
  const dissolveId = layout.entries.some((e) => e.crossfadeFrames) ? `r${nextId++}` : "";
  if (dissolveId) resources.push(`    <effect id="${dissolveId}" name="Cross Dissolve" uid="${CROSS_DISSOLVE_UID}"/>`);

  const spine: string[] = [];
  layout.entries.forEach((e, i) => {
    const ref = assetIds.get(e.clip.clipId)!;
    const clipStart = sumTime({ frames: e.clip.startFrames ?? 0, fps: e.clip.fps }, { frames: e.srcInFrames, fps: spec.fps });
    if (e.crossfadeFrames) {
      const half = e.crossfadeFrames / 2;
      spine.push(
        `          <transition name="Cross Dissolve" offset="${fcpTime(e.recInFrames - half, spec.fps)}" duration="${fcpTime(e.crossfadeFrames, spec.fps)}">`,
        `            <filter-video ref="${dissolveId}" name="Cross Dissolve"/>`,
        "          </transition>",
      );
    }
    const open = `          <asset-clip ref="${ref}" offset="${fcpTime(e.recInFrames, spec.fps)}" name="${esc(path.parse(e.clip.path).name)}" start="${clipStart}" duration="${fcpTime(e.durFrames, spec.fps)}"`;
    if (i === 0 && music) {
      const track = music.track;
      const fades = [
        track.fadeInSec === 0 ? "" : `<fadeIn type="easeIn" duration="${fcpTime(secondsToFrames(track.fadeInSec ?? 1, spec.fps), spec.fps)}"/>`,
        track.fadeOutSec === 0 ? "" : `<fadeOut type="easeOut" duration="${fcpTime(secondsToFrames(track.fadeOutSec ?? 3, spec.fps), spec.fps)}"/>`,
      ].join("");
      // A connected clip is placed in the time of the clip it hangs from, which counts from that clip's own start.
      spine.push(
        `${open}>`,
        `            <asset-clip ref="${musicId}" lane="-1" offset="${clipStart}" name="${esc(path.parse(track.path).name)}" start="${fcpTime(music.srcInFrames, spec.fps)}" duration="${fcpTime(music.durFrames, spec.fps)}" audioRole="music">`,
        `              <adjust-volume amount="${track.gainDb ?? -12}dB">${fades ? `<param name="amount">${fades}</param>` : ""}</adjust-volume>`,
        "            </asset-clip>",
        "          </asset-clip>",
      );
    } else spine.push(`${open}/>`);
  });
  if (music) warnings.push("The music's placement under the first clip and its fades follow Apple's published format but have not been tried in Final Cut Pro; check them after importing.");
  if (layout.entries.some((e) => e.crossfadeFrames)) warnings.push("The crossfades use Final Cut's built-in Cross Dissolve; its identifier is not in Apple's documentation, so check the transitions after importing.");

  const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="${version}">
  <resources>
${resources.join("\n")}
  </resources>
  <library>
    <event name="VivahLens">
      <project name="${esc(spec.name)}">
        <sequence format="${seqFormat}" duration="${fcpTime(layout.totalFrames, spec.fps)}" tcStart="0s" tcFormat="${drop ? "DF" : "NDF"}" audioLayout="stereo" audioRate="48k">
          <spine>
${spine.join("\n")}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
  return { text, warnings: [...new Set(warnings)], durationFrames: layout.totalFrames };
}
