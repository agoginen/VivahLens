/** A frame rate as an exact fraction, e.g. 30000/1001 for 29.97, so timeline arithmetic never drifts. */
export interface Fps {
  num: number;
  den: number;
}

const KNOWN: Record<string, Fps> = {
  "23.976": { num: 24000, den: 1001 },
  "24": { num: 24, den: 1 },
  "25": { num: 25, den: 1 },
  "29.97": { num: 30000, den: 1001 },
  "30": { num: 30, den: 1 },
  "50": { num: 50, den: 1 },
  "59.94": { num: 60000, den: 1001 },
  "60": { num: 60, den: 1 },
};

/** Accepts "25", "29.97", "30000/1001". Rates like 29.97 snap to their exact broadcast fraction. */
export function parseFps(input: string | number): Fps {
  const text = String(input).trim();
  const frac = /^(\d+)\/(\d+)$/.exec(text);
  if (frac) {
    const [num, den] = [Number(frac[1]), Number(frac[2])];
    if (num > 0 && den > 0) return { num, den };
  } else {
    const value = Number(text);
    if (Number.isFinite(value) && value > 0) {
      const exact = Object.entries(KNOWN).find(([k]) => Math.abs(Number(k) - value) < 0.005);
      return exact ? exact[1] : { num: Math.round(value * 1000), den: 1000 };
    }
  }
  throw new Error(`Invalid frame rate "${input}"`);
}

export const fpsValue = (f: Fps): number => f.num / f.den;

export const secondsToFrames = (sec: number, f: Fps): number => Math.round((sec * f.num) / f.den);
export const framesToSeconds = (frames: number, f: Fps): number => (frames * f.den) / f.num;

/** Whole-number frame rate used for timecode counting (29.97 counts 30 frames per second, non-drop). */
export const nominalFps = (f: Fps): number => Math.round(f.num / f.den);

/** Drop-frame timecode skips frame numbers (not frames) so it keeps pace with the clock; it only exists for 29.97 and 59.94. */
export const supportsDropFrame = (f: Fps): boolean => f.den === 1001 && nominalFps(f) % 30 === 0;

/**
 * Timecode "HH:MM:SS:FF", or "HH:MM:SS;FF" when `drop` is set. Drop-frame skips two frame numbers (four at 59.94) at the
 * start of every minute except each tenth, so a count of frames and a timecode only agree when the same rule is used both ways.
 */
export function timecode(frames: number, f: Fps, drop = false): string {
  const n = nominalFps(f);
  if (drop && !supportsDropFrame(f)) throw new Error("Drop-frame timecode only exists for 29.97 and 59.94 fps");
  let counted = frames;
  if (drop) {
    const skipped = (n / 30) * 2;
    const perTenMinutes = n * 600 - skipped * 9;
    const perMinute = n * 60 - skipped;
    const tens = Math.floor(frames / perTenMinutes);
    const rest = frames % perTenMinutes;
    counted = frames + skipped * 9 * tens + (rest > skipped ? skipped * Math.floor((rest - skipped) / perMinute) : 0);
  }
  const ff = counted % n;
  const totalSec = Math.floor(counted / n);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor(totalSec / 60) % 60)}:${pad(totalSec % 60)}${drop ? ";" : ":"}${pad(ff)}`;
}

/**
 * The frame count of a timecode ("HH:MM:SS:FF"; a ";" or "." before the frames means drop-frame, as ffprobe reports it) and
 * whether it was drop-frame. Counts from 00:00:00:00, so a clip's embedded start timecode becomes a frame offset.
 */
export function parseTimecode(text: string, f: Fps): { frames: number; drop: boolean } {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})([:;.])(\d{2,3})$/.exec(text.trim());
  if (!m) throw new Error(`Bad timecode "${text}"`);
  const [hh, mm, ss, ff] = [m[1], m[2], m[3], m[5]].map(Number) as [number, number, number, number];
  const drop = m[4] !== ":";
  const n = nominalFps(f);
  if (drop && !supportsDropFrame(f)) throw new Error(`Drop-frame timecode "${text}" does not fit ${f.num}/${f.den} fps`);
  if (ff >= n || mm >= 60 || ss >= 60) throw new Error(`Timecode "${text}" is out of range for ${n} frames per second`);
  let frames = (hh * 3600 + mm * 60 + ss) * n + ff;
  if (drop) {
    const minutes = hh * 60 + mm;
    frames -= (n / 30) * 2 * (minutes - Math.floor(minutes / 10));
  }
  return { frames, drop };
}

/** FCPXML rational time: "0s" or "<frames*den>/<num>s", always frame-aligned. */
export const fcpTime = (frames: number, f: Fps): string => (frames === 0 ? "0s" : `${frames * f.den}/${f.num}s`);

export const fcpFrameDuration = (f: Fps): string => `${f.den}/${f.num}s`;
