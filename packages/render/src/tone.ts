import { clamp, clamp01, illuminantRgb, lerp, luma, smoothstep } from "./color.js";

/** Kelvin the picture is taken to have been balanced to when nothing better is known (daylight). */
export const DEFAULT_AS_SHOT_K = 5500;

/** The most green the tint slider adds or removes, in stops, at its ends. */
const TINT_STOPS = 0.4;

/**
 * Per-channel gains (on linear light) for moving the white balance from `asShotK` to `tempK` and shifting tint.
 * A higher temperature says the light was bluer, so the picture comes out warmer, as in Lightroom. Brightness is kept.
 */
export function whiteBalanceGains(tempK: number | undefined, tint: number | undefined, asShotK: number): [number, number, number] {
  const from = illuminantRgb(asShotK);
  const to = illuminantRgb(tempK ?? asShotK);
  let g: [number, number, number] = [from[0] / to[0], from[1] / to[1], from[2] / to[2]];
  g[1] *= 2 ** (-((tint ?? 0) / 150) * TINT_STOPS);
  const y = luma(g[0], g[1], g[2]);
  g = [g[0] / y, g[1] / y, g[2] / y];
  return g;
}

/** Multiplies linear-light pixels by per-channel gains. */
export function applyGains(px: Float32Array, r: number, g: number, b: number): void {
  for (let i = 0; i < px.length; i += 3) {
    px[i]! *= r;
    px[i + 1]! *= g;
    px[i + 2]! *= b;
  }
}

export interface ToneSliders {
  highlights?: number | undefined;
  shadows?: number | undefined;
  whites?: number | undefined;
  blacks?: number | undefined;
  contrast?: number | undefined;
}

const LUT_SIZE = 1024;

/**
 * One brightness mapping (on encoded values, 0 to 1) for the tone sliders. Each of highlights, shadows, whites and blacks
 * moves the part of the range it names by up to a quarter of the range; contrast bends the whole range into an S (or,
 * negative, flattens it). Returns undefined when every slider is zero.
 */
export function buildToneLut(s: ToneSliders): Float32Array | undefined {
  const h = (s.highlights ?? 0) / 100;
  const sh = (s.shadows ?? 0) / 100;
  const w = (s.whites ?? 0) / 100;
  const bl = (s.blacks ?? 0) / 100;
  const c = (s.contrast ?? 0) / 100;
  if (!h && !sh && !w && !bl && !c) return undefined;
  const lut = new Float32Array(LUT_SIZE + 1);
  for (let i = 0; i <= LUT_SIZE; i++) {
    const l = i / LUT_SIZE;
    let out = l;
    out += 0.25 * sh * smoothstep(0.6, 0, l);
    out += 0.25 * h * smoothstep(0.4, 1, l);
    out += 0.2 * bl * smoothstep(0.3, 0, l);
    out += 0.2 * w * smoothstep(0.7, 1, l);
    out = clamp01(out);
    const s = out * out * (3 - 2 * out);
    lut[i] = clamp01(out + c * (s - out));
  }
  return lut;
}

const lookup = (lut: Float32Array, x: number): number => {
  const t = clamp01(x) * LUT_SIZE;
  const i = t | 0;
  return i >= LUT_SIZE ? lut[LUT_SIZE]! : lut[i]! + (lut[i + 1]! - lut[i]!) * (t - i);
};

/**
 * Remaps the brightness of encoded pixels through `lut`, keeping each pixel's colour ratios where it is bright enough to
 * have a colour, and shifting the channels equally in the darkest tones (where a ratio would blow up noise).
 */
export function applyLumaLut(px: Float32Array, lut: Float32Array): void {
  for (let i = 0; i < px.length; i += 3) {
    const r = px[i]!;
    const g = px[i + 1]!;
    const b = px[i + 2]!;
    const l = luma(r, g, b);
    const target = lookup(lut, l);
    const delta = target - l;
    const ratio = l > 1e-4 ? target / l : 1;
    const t = smoothstep(0.01, 0.05, l);
    px[i] = clamp01(t * r * ratio + (1 - t) * (r + delta));
    px[i + 1] = clamp01(t * g * ratio + (1 - t) * (g + delta));
    px[i + 2] = clamp01(t * b * ratio + (1 - t) * (b + delta));
  }
}

export interface CurvePoint {
  input: number;
  output: number;
}

/**
 * A smooth curve through the points (monotone cubic interpolation, so it never overshoots between them), as 256 output
 * values from 0 to 1. Ends at (0, 0) and (255, 255) unless the points say otherwise. Undefined for an identity curve.
 */
export function buildCurveLut(points: readonly CurvePoint[]): Float32Array | undefined {
  const sorted = points
    .map((p) => ({ x: clamp(p.input, 0, 255), y: clamp(p.output, 0, 255) }))
    .sort((a, b) => a.x - b.x)
    .filter((p, i, all) => i === 0 || p.x > all[i - 1]!.x);
  if (sorted.length === 0) return undefined;
  if (sorted[0]!.x > 0) sorted.unshift({ x: 0, y: 0 });
  if (sorted[sorted.length - 1]!.x < 255) sorted.push({ x: 255, y: 255 });
  if (sorted.every((p) => Math.abs(p.x - p.y) < 0.5)) return undefined;

  const n = sorted.length;
  const dx = new Array<number>(n - 1);
  const slope = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = sorted[i + 1]!.x - sorted[i]!.x;
    slope[i] = (sorted[i + 1]!.y - sorted[i]!.y) / dx[i]!;
  }
  const tangent = new Array<number>(n);
  tangent[0] = slope[0]!;
  tangent[n - 1] = slope[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    const a = slope[i - 1]!;
    const b = slope[i]!;
    tangent[i] = a * b <= 0 ? 0 : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / a + (dx[i]! + 2 * dx[i - 1]!) / b);
  }
  const lut = new Float32Array(256);
  let seg = 0;
  for (let v = 0; v < 256; v++) {
    while (seg < n - 2 && v > sorted[seg + 1]!.x) seg++;
    const p0 = sorted[seg]!;
    const p1 = sorted[seg + 1]!;
    const t = (v - p0.x) / dx[seg]!;
    const t2 = t * t;
    const t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * p0.y + (t3 - 2 * t2 + t) * dx[seg]! * tangent[seg]! + (-2 * t3 + 3 * t2) * p1.y + (t3 - t2) * dx[seg]! * tangent[seg + 1]!;
    lut[v] = clamp01(y / 255);
  }
  return lut;
}

/** Applies a 256-entry curve to every channel of encoded pixels. */
export function applyCurveLut(px: Float32Array, lut: Float32Array): void {
  for (let i = 0; i < px.length; i++) {
    const t = clamp01(px[i]!) * 255;
    const k = t | 0;
    px[i] = k >= 255 ? lut[255]! : lerp(lut[k]!, lut[k + 1]!, t - k);
  }
}
