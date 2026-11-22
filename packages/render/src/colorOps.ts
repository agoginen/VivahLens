import { HSL_COLORS, type RecipeAdjustments } from "@vivahlens/core";
import { clamp01, hslToRgb, luma, rgbToHsl, smoothstep } from "./color.js";

/** Scales how far each channel is from the pixel's brightness. `scale` 1 leaves the picture alone, 0 makes it grey. */
export function applySaturation(px: Float32Array, scale: number): void {
  if (scale === 1) return;
  for (let i = 0; i < px.length; i += 3) {
    const r = px[i]!;
    const g = px[i + 1]!;
    const b = px[i + 2]!;
    const y = luma(r, g, b);
    px[i] = clamp01(y + (r - y) * scale);
    px[i + 1] = clamp01(y + (g - y) * scale);
    px[i + 2] = clamp01(y + (b - y) * scale);
  }
}

/**
 * Saturation that favours the dull colours and spares ones that are already strong, and goes easy on skin tones, so
 * faces do not turn orange. `amount` is -100 to 100.
 */
export function applyVibrance(px: Float32Array, amount: number): void {
  if (!amount) return;
  const a = amount / 100;
  const hsl = new Float32Array(3);
  for (let i = 0; i < px.length; i += 3) {
    const r = px[i]!;
    const g = px[i + 1]!;
    const b = px[i + 2]!;
    const max = Math.max(r, g, b);
    const sat = max > 0 ? (max - Math.min(r, g, b)) / max : 0;
    rgbToHsl(r, g, b, hsl);
    const skin = Math.max(0, 1 - Math.abs(hsl[0]! - 28) / 28);
    const scale = 1 + a * (1 - sat) * (1 - 0.65 * skin);
    const y = luma(r, g, b);
    px[i] = clamp01(y + (r - y) * scale);
    px[i + 1] = clamp01(y + (g - y) * scale);
    px[i + 2] = clamp01(y + (b - y) * scale);
  }
}

/** Where each named colour sits on the hue wheel, in degrees. */
const BAND_HUES: Record<(typeof HSL_COLORS)[number], number> = { red: 0, orange: 30, yellow: 60, green: 120, aqua: 180, blue: 240, purple: 275, magenta: 315 };

/** The most the hue slider turns a colour, in degrees, at its ends. */
const HUE_RANGE = 30;
/** The most the luminance slider lightens or darkens a colour (fraction of the available range), at its ends. */
const LUMINANCE_RANGE = 0.25;

type Hsl = NonNullable<RecipeAdjustments["hsl"]>;

/**
 * Per-colour hue, saturation and luminance. Each pixel is influenced by the two bands whose centres it lies between, in
 * proportion to how close it is to each, and greys and the extreme darks and lights are left alone.
 */
export function applyHsl(px: Float32Array, hsl: Hsl): void {
  const hue = HSL_COLORS.map((c) => hsl[c]?.hue ?? 0);
  const sat = HSL_COLORS.map((c) => hsl[c]?.saturation ?? 0);
  const lum = HSL_COLORS.map((c) => hsl[c]?.luminance ?? 0);
  if ([...hue, ...sat, ...lum].every((v) => v === 0)) return;
  const centres = HSL_COLORS.map((c) => BAND_HUES[c]);
  const n = centres.length;
  const v = new Float32Array(3);
  for (let i = 0; i < px.length; i += 3) {
    rgbToHsl(px[i]!, px[i + 1]!, px[i + 2]!, v);
    const h = v[0]!;
    const s = v[1]!;
    const l = v[2]!;
    const dark = 2 * l - 1;
    const colourful = smoothstep(0, 0.2, s) * (1 - dark * dark * dark * dark);
    if (colourful <= 0) continue;

    let lo = n - 1;
    for (let k = 0; k < n; k++) if (centres[k]! <= h) lo = k;
    const hi = (lo + 1) % n;
    const start = centres[lo]!;
    const span = (hi === 0 ? 360 : centres[hi]!) - start;
    const t = smoothstep(0, 1, (h >= start ? h - start : h - start + 360) / span);
    const dh = hue[lo]! * (1 - t) + hue[hi]! * t;
    const ds = sat[lo]! * (1 - t) + sat[hi]! * t;
    const dl = lum[lo]! * (1 - t) + lum[hi]! * t;

    const newS = Math.min(1, Math.max(0, s * (1 + (ds / 100) * colourful)));
    const room = dl > 0 ? 1 - l : l;
    const newL = clamp01(l + (dl / 100) * colourful * LUMINANCE_RANGE * 2 * room);
    hslToRgb(h + (dh / 100) * HUE_RANGE * colourful, newS, newL, v);
    px[i] = clamp01(v[0]!);
    px[i + 1] = clamp01(v[1]!);
    px[i + 2] = clamp01(v[2]!);
  }
}

type SplitToning = NonNullable<RecipeAdjustments["splitToning"]>;

/** How strongly a fully saturated tint colours the picture, at most. */
const TINT_STRENGTH = 0.35;

/**
 * Tints the shadows and the highlights with their own colours without changing brightness. `balance` (-100 to 100)
 * moves the point that divides shadows from highlights toward the shadows (negative) or the highlights (positive).
 */
export function applySplitToning(px: Float32Array, s: SplitToning): void {
  const hs = (s.highlightSaturation ?? 0) / 100;
  const ss = (s.shadowSaturation ?? 0) / 100;
  if (!hs && !ss) return;
  const pivot = 0.5 + (s.balance ?? 0) / 200;
  const tint = new Float32Array(3);
  const colour = (hue: number | undefined, sat: number): [number, number, number] => {
    if (!sat) return [0, 0, 0];
    hslToRgb(hue ?? 0, 1, 0.5, tint);
    const y = luma(tint[0]!, tint[1]!, tint[2]!);
    return [(tint[0]! - y) * sat * TINT_STRENGTH, (tint[1]! - y) * sat * TINT_STRENGTH, (tint[2]! - y) * sat * TINT_STRENGTH];
  };
  const highlight = colour(s.highlightHue, hs);
  const shadow = colour(s.shadowHue, ss);
  for (let i = 0; i < px.length; i += 3) {
    const l = luma(px[i]!, px[i + 1]!, px[i + 2]!);
    const wh = smoothstep(pivot - 0.2, pivot + 0.4, l);
    const ws = smoothstep(pivot + 0.2, pivot - 0.4, l);
    for (let c = 0; c < 3; c++) px[i + c] = clamp01(px[i + c]! + highlight[c]! * wh + shadow[c]! * ws);
  }
}
