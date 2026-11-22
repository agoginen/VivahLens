import { boxBlur, gaussianBlur } from "./blur.js";
import { clamp, clamp01, luma, smoothstep } from "./color.js";

/** Brightness plane of encoded pixels. */
export function lumaPlane(px: Float32Array): Float32Array {
  const plane = new Float32Array(px.length / 3);
  for (let i = 0, p = 0; i < px.length; i += 3, p++) plane[p] = luma(px[i]!, px[i + 1]!, px[i + 2]!);
  return plane;
}

function addToAll(px: Float32Array, delta: Float32Array): void {
  for (let i = 0, p = 0; i < px.length; i += 3, p++) {
    const d = delta[p]!;
    px[i] = clamp01(px[i]! + d);
    px[i + 1] = clamp01(px[i + 1]! + d);
    px[i + 2] = clamp01(px[i + 2]! + d);
  }
}

/**
 * Local contrast. Texture works at the scale of fine detail, clarity at the scale of mid-sized structure and mostly in
 * the mid-tones, so highlights and shadows keep their depth. Negative values soften instead of sharpen.
 */
export function applyLocalContrast(px: Float32Array, w: number, h: number, clarity: number, texture: number): void {
  if (!clarity && !texture) return;
  const edge = Math.max(w, h);
  const plane = lumaPlane(px);
  const delta = new Float32Array(plane.length);
  if (clarity) {
    const blur = gaussianBlur(plane, w, h, 0.012 * edge);
    const a = (clarity / 100) * 0.9;
    for (let p = 0; p < delta.length; p++) delta[p]! += (plane[p]! - blur[p]!) * a * 4 * plane[p]! * (1 - plane[p]!);
  }
  if (texture) {
    const blur = gaussianBlur(plane, w, h, 0.0025 * edge);
    const a = (texture / 100) * 1.2;
    for (let p = 0; p < delta.length; p++) delta[p]! += (plane[p]! - blur[p]!) * a;
  }
  addToAll(px, delta);
}

/**
 * Unsharp mask on brightness. `radius` is in pixels of the finished picture, and `detailScale` (how much smaller this
 * render is than the one the recipe is for) keeps a downsized preview in proportion.
 */
export function applySharpening(px: Float32Array, w: number, h: number, amount: number, radius: number, detailScale: number): void {
  if (!amount) return;
  const plane = lumaPlane(px);
  const blur = gaussianBlur(plane, w, h, Math.max(0.5, radius * detailScale));
  const a = amount / 100;
  const delta = new Float32Array(plane.length);
  for (let p = 0; p < delta.length; p++) delta[p] = (plane[p]! - blur[p]!) * a;
  addToAll(px, delta);
}

/**
 * Noise reduction. Colour noise is blurred away in the red-minus-brightness and blue-minus-brightness channels;
 * brightness noise is blurred only where there is no real edge, so detail survives.
 */
export function applyNoiseReduction(px: Float32Array, w: number, h: number, luminance: number, color: number): void {
  if (!luminance && !color) return;
  const edge = Math.max(w, h);
  const n = w * h;
  const y = lumaPlane(px);
  const cr = new Float32Array(n);
  const cb = new Float32Array(n);
  for (let i = 0, p = 0; p < n; i += 3, p++) {
    cr[p] = px[i]! - y[p]!;
    cb[p] = px[i + 2]! - y[p]!;
  }
  let newY: Float32Array = y;
  let newCr: Float32Array = cr;
  let newCb: Float32Array = cb;
  if (color) {
    const sigma = 0.002 * edge + (color / 100) * 0.006 * edge;
    newCr = gaussianBlur(cr, w, h, sigma);
    newCb = gaussianBlur(cb, w, h, sigma);
    const keep = 1 - Math.min(1, color / 100);
    for (let p = 0; p < n; p++) {
      newCr[p] = cr[p]! * keep + newCr[p]! * (1 - keep);
      newCb[p] = cb[p]! * keep + newCb[p]! * (1 - keep);
    }
  }
  if (luminance) {
    const amount = Math.min(1, luminance / 100);
    const blur = gaussianBlur(y, w, h, 0.0015 * edge + amount * 0.004 * edge);
    newY = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      const real = smoothstep(0.015, 0.09, Math.abs(y[p]! - blur[p]!));
      newY[p] = y[p]! + (blur[p]! - y[p]!) * amount * (1 - real);
    }
  }
  for (let i = 0, p = 0; p < n; i += 3, p++) {
    const r = newY[p]! + newCr[p]!;
    const b = newY[p]! + newCb[p]!;
    px[i] = clamp01(r);
    px[i + 2] = clamp01(b);
    px[i + 1] = clamp01((newY[p]! - 0.2126 * r - 0.0722 * b) / 0.7152);
  }
}

/**
 * Haze removal on linear light: estimates how much haze veils each pixel from the darkest channel nearby, and undoes it
 * (positive), or adds a veil of the scene's brightest light (negative).
 */
export function applyDehaze(px: Float32Array, w: number, h: number, amount: number): void {
  if (!amount) return;
  const n = w * h;
  if (amount < 0) {
    const k = 0.5 * (-amount / 100);
    for (let i = 0; i < px.length; i++) px[i] = px[i]! * (1 - k) + k;
    return;
  }
  const darkest = new Float32Array(n);
  const peak: number[] = [];
  for (let i = 0, p = 0; p < n; i += 3, p++) {
    darkest[p] = Math.min(px[i]!, px[i + 1]!, px[i + 2]!);
    if (p % 7 === 0) peak.push(Math.max(px[i]!, px[i + 1]!, px[i + 2]!));
  }
  peak.sort((a, b) => a - b);
  const airlight = clamp(peak[Math.floor(peak.length * 0.995)] ?? 1, 0.5, 1);
  const dark = boxBlur(darkest, w, h, 0.01 * Math.max(w, h));
  const k = 0.8 * (amount / 100);
  for (let i = 0, p = 0; p < n; i += 3, p++) {
    const t = clamp(1 - (k * dark[p]!) / airlight, 0.2, 1);
    for (let c = 0; c < 3; c++) px[i + c] = (px[i + c]! - airlight) / t + airlight;
  }
}

export interface VignetteSettings {
  amount?: number | undefined;
  midpoint?: number | undefined;
  feather?: number | undefined;
  roundness?: number | undefined;
}

/** How many stops the corners are darkened (or lightened) at full strength. */
const VIGNETTE_STOPS = 1.5;

/** Darkens or lightens toward the corners of encoded pixels; gain is worked out in stops, then converted for encoded values. */
export function applyVignette(px: Float32Array, w: number, h: number, v: VignetteSettings): void {
  const amount = (v.amount ?? 0) / 100;
  if (!amount) return;
  const inner = ((v.midpoint ?? 50) / 100) * 0.8;
  const width = Math.max(0.05, ((v.feather ?? 50) / 100) * 0.8);
  const round = (v.roundness ?? 0) / 100;
  const halfDiagonal = Math.hypot(w, h) / 2;
  for (let y = 0; y < h; y++) {
    const ny = ((y + 0.5) / h) * 2 - 1;
    for (let x = 0; x < w; x++) {
      const nx = ((x + 0.5) / w) * 2 - 1;
      // Distance from the centre, 1 at the corners: an ellipse that follows the frame, bent toward a true circle
      // (roundness above 0) or toward the frame's own rectangle (below 0).
      const ellipse = Math.hypot(nx, ny) / Math.SQRT2;
      const circle = Math.hypot((nx * w) / 2, (ny * h) / 2) / halfDiagonal;
      const frame = Math.max(Math.abs(nx), Math.abs(ny));
      const d = round >= 0 ? ellipse + (circle - ellipse) * round : ellipse + (frame - ellipse) * -round;
      const t = smoothstep(inner, inner + width, d);
      const gain = 2 ** ((amount * VIGNETTE_STOPS * t) / 2.2);
      const i = (y * w + x) * 3;
      px[i] = clamp01(px[i]! * gain);
      px[i + 1] = clamp01(px[i + 1]! * gain);
      px[i + 2] = clamp01(px[i + 2]! * gain);
    }
  }
}

export interface GrainSettings {
  amount?: number | undefined;
  size?: number | undefined;
  roughness?: number | undefined;
}

/** A small deterministic random generator, so the same inputs always render the same grain. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Film grain: seeded noise, softened for larger grain, strongest in the mid-tones. */
export function applyGrain(px: Float32Array, w: number, h: number, g: GrainSettings, seed: number): void {
  const amount = (g.amount ?? 0) / 100;
  if (!amount) return;
  const rand = mulberry32(seed);
  const n = w * h;
  const noise = new Float32Array(n);
  for (let p = 0; p < n; p += 2) {
    // Box-Muller: two normal samples from two uniform ones.
    const u = Math.max(rand(), 1e-9);
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    noise[p] = r * Math.cos(2 * Math.PI * v);
    if (p + 1 < n) noise[p + 1] = r * Math.sin(2 * Math.PI * v);
  }
  const size = (g.size ?? 25) / 100;
  const roughness = (g.roughness ?? 50) / 100;
  let shaped = noise;
  if (size > 0.05) {
    const soft = gaussianBlur(noise, w, h, 0.4 + size * 1.8 * Math.max(1, Math.max(w, h) / 2000));
    let sum = 0;
    for (let p = 0; p < n; p++) sum += soft[p]! * soft[p]!;
    const scale = 1 / Math.sqrt(Math.max(sum / n, 1e-9));
    shaped = new Float32Array(n);
    for (let p = 0; p < n; p++) shaped[p] = soft[p]! * scale * (1 - roughness * 0.5) + noise[p]! * roughness * 0.5;
  }
  const strength = amount * 0.09;
  for (let i = 0, p = 0; p < n; i += 3, p++) {
    const l = luma(px[i]!, px[i + 1]!, px[i + 2]!);
    const d = shaped[p]! * strength * (0.35 + 0.65 * 4 * l * (1 - l));
    px[i] = clamp01(px[i]! + d);
    px[i + 1] = clamp01(px[i + 1]! + d);
    px[i + 2] = clamp01(px[i + 2]! + d);
  }
}
