import type { Rgba } from "@vivahlens/ingest";

export type { Rgba };

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 0 below `edge0`, 1 above `edge1`, smooth between; the edges may be given in either order. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const ENCODE_STEPS = 8192;
const LINEAR_TO_SRGB = new Float32Array(ENCODE_STEPS + 2);
for (let i = 0; i <= ENCODE_STEPS + 1; i++) {
  const x = Math.min(1, i / ENCODE_STEPS);
  LINEAR_TO_SRGB[i] = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

/** Linear light for an 8-bit sRGB value. */
export const srgb8ToLinear = (v: number): number => SRGB_TO_LINEAR[v]!;

/** sRGB encoding (0 to 1) of a linear value; inputs outside 0 to 1 are clamped. */
export function linearToSrgb(x: number): number {
  const t = clamp01(x) * ENCODE_STEPS;
  const i = t | 0;
  return LINEAR_TO_SRGB[i]! + (LINEAR_TO_SRGB[i + 1]! - LINEAR_TO_SRGB[i]!) * (t - i);
}

export function srgbToLinear(v: number): number {
  const c = clamp01(v);
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Rec. 709 weights: the brightness of an (encoded or linear) RGB triple. */
export const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Hue in degrees (0 to 360), saturation and lightness (0 to 1) of an RGB triple. Writes into `out` to stay allocation-free in pixel loops. */
export function rgbToHsl(r: number, g: number, b: number, out: Float32Array): void {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 1e-6) {
    s = d / (1 - Math.abs(2 * l - 1) + 1e-9);
    if (max === r) {
      h = (g - b) / d;
      if (h < 0) h += 6;
    } else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  out[0] = h;
  out[1] = s > 1 ? 1 : s;
  out[2] = l;
}

export function hslToRgb(h: number, s: number, l: number, out: Float32Array): void {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h - 360 * Math.floor(h / 360)) / 60;
  const x = c * (1 - Math.abs(hp - 2 * Math.floor(hp / 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = l - c / 2;
  out[0] = r + m;
  out[1] = g + m;
  out[2] = b + m;
}

/**
 * The colour of a black-body light at `kelvin`, as linear sRGB scaled so green is 1 (CIE xy from the Kim et al. 2002 fit
 * of the Planckian locus, valid 1667 to 25000 K). Used to turn a colour-temperature change into per-channel gains.
 */
export function illuminantRgb(kelvin: number): [number, number, number] {
  const t = clamp(kelvin, 2000, 15000);
  const x = t <= 4000 ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991 : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039;
  let y: number;
  if (t <= 2222) y = -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683;
  else if (t <= 4000) y = -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867;
  else y = 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  const bigX = x / y;
  const bigZ = (1 - x - y) / y;
  const r = 3.2404542 * bigX - 1.5371385 - 0.4985314 * bigZ;
  const g = -0.969266 * bigX + 1.8760108 + 0.041556 * bigZ;
  const b = 0.0556434 * bigX - 0.2040259 + 1.0572252 * bigZ;
  return [r / g, 1, b / g];
}
