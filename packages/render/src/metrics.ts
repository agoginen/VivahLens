import { downscale } from "@vivahlens/ingest";
import { srgbToLinear, type Rgba } from "./color.js";

// Measures of how different two pictures look, for scoring edits by what they do to the picture instead of by how close
// their slider values are (plan §7.5). CIEDE2000 is the colour difference; SSIM is the structural similarity of the lightness.

const WHITE_X = 0.95047; // D65, 2 degrees
const WHITE_Z = 1.08883;
const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;
const lab = (t: number): number => (t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116);

function labOfLinear(r: number, g: number, b: number): [number, number, number] {
  const fx = lab((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / WHITE_X);
  const fy = lab(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const fz = lab((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / WHITE_Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE L*a*b* (D65) of an sRGB colour given as 0 to 255 values. */
export const srgbToLab = (r: number, g: number, b: number): [number, number, number] => labOfLinear(srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255));

const POW_25_7 = 25 ** 7;
const RAD = Math.PI / 180;
const pow7 = (x: number): number => {
  const x2 = x * x;
  return x2 * x2 * x2 * x;
};
const hueDegrees = (b: number, a: number): number => {
  if (a === 0 && b === 0) return 0;
  const h = Math.atan2(b, a) / RAD;
  return h < 0 ? h + 360 : h;
};

/**
 * The CIEDE2000 colour difference of two CIE L*a*b* colours, with the three weighting factors at 1. Follows Sharma, Wu and
 * Dalal, "The CIEDE2000 Color-Difference Formula: Implementation Notes, Supplementary Test Data, and Mathematical
 * Observations" (2005), including its treatment of grey colours and of hues across the 0/360 degree line.
 * About 1 is the smallest difference a trained eye sees side by side; 2 to 3 shows at a glance; above 5 is plainly different.
 */
export function deltaE2000(L1: number, a1: number, b1: number, L2: number, a2: number, b2: number): number {
  const meanChroma = (Math.sqrt(a1 * a1 + b1 * b1) + Math.sqrt(a2 * a2 + b2 * b2)) / 2;
  const mc7 = pow7(meanChroma);
  const g = 0.5 * (1 - Math.sqrt(mc7 / (mc7 + POW_25_7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);
  const h1p = hueDegrees(b1, a1p);
  const h2p = hueDegrees(b2, a2p);

  const dL = L2 - L1;
  const dC = C2p - C1p;
  const chromaProduct = C1p * C2p;
  let dh = 0;
  if (chromaProduct !== 0) {
    dh = h2p - h1p;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(chromaProduct) * Math.sin((dh * RAD) / 2);

  const meanL = (L1 + L2) / 2;
  const meanC = (C1p + C2p) / 2;
  let meanH: number;
  if (chromaProduct === 0) meanH = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) meanH = (h1p + h2p) / 2;
  else meanH = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;

  const t =
    1 - 0.17 * Math.cos((meanH - 30) * RAD) + 0.24 * Math.cos(2 * meanH * RAD) + 0.32 * Math.cos((3 * meanH + 6) * RAD) - 0.2 * Math.cos((4 * meanH - 63) * RAD);
  const theta = 30 * Math.exp(-(((meanH - 275) / 25) ** 2));
  const mC7 = pow7(meanC);
  const rotation = -Math.sin(2 * theta * RAD) * 2 * Math.sqrt(mC7 / (mC7 + POW_25_7));
  const l50 = meanL - 50;
  const sl = 1 + (0.015 * l50 * l50) / Math.sqrt(20 + l50 * l50);
  const sc = 1 + 0.045 * meanC;
  const sh = 1 + 0.015 * meanC * t;

  const l = dL / sl;
  const c = dC / sc;
  const h = dH / sh;
  return Math.sqrt(l * l + c * c + h * h + rotation * c * h);
}

const WINDOW = 11;
const SIGMA = 1.5;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;
const KERNEL = (() => {
  const weights = Float64Array.from({ length: WINDOW }, (_, i) => Math.exp(-((i - (WINDOW - 1) / 2) ** 2) / (2 * SIGMA * SIGMA)));
  const total = weights.reduce((s, w) => s + w, 0);
  return weights.map((w) => w / total);
})();

/** Gaussian-weighted local averages, for every window that lies entirely inside the picture. */
function localMean(src: Float64Array, width: number, height: number): Float64Array {
  const outW = width - WINDOW + 1;
  const outH = height - WINDOW + 1;
  const across = new Float64Array(outW * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < outW; x++) {
      let sum = 0;
      for (let k = 0; k < WINDOW; k++) sum += KERNEL[k]! * src[y * width + x + k]!;
      across[y * outW + x] = sum;
    }
  }
  const out = new Float64Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let sum = 0;
      for (let k = 0; k < WINDOW; k++) sum += KERNEL[k]! * across[(y + k) * outW + x]!;
      out[y * outW + x] = sum;
    }
  }
  return out;
}

const lightness = (img: Rgba): Float64Array => {
  const out = new Float64Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) out[i] = 0.2126 * img.data[i * 4]! + 0.7152 * img.data[i * 4 + 1]! + 0.0722 * img.data[i * 4 + 2]!;
  return out;
};

function assertSameSize(a: Rgba, b: Rgba): void {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`The pictures differ in size (${a.width}x${a.height} and ${b.width}x${b.height})`);
}

/**
 * Structural similarity of two pictures' lightness (Wang, Bovik, Sheikh and Simoncelli, 2004): 1 for identical, falling as
 * brightness, contrast or structure differ, and below 0 when one is the other turned inside out. Averaged over every
 * 11x11 Gaussian window (sigma 1.5) inside the picture; a picture smaller than a window is compared as one whole.
 */
export function ssim(a: Rgba, b: Rgba): number {
  assertSameSize(a, b);
  const { width, height } = a;
  const x = lightness(a);
  const y = lightness(b);
  const index = (xs: Float64Array, ys: Float64Array) => xs.map((v, i) => v * ys[i]!);

  if (width < WINDOW || height < WINDOW) {
    const n = x.length;
    const mean = (v: Float64Array) => v.reduce((s, e) => s + e, 0) / n;
    const mx = mean(x);
    const my = mean(y);
    const vx = mean(index(x, x)) - mx * mx;
    const vy = mean(index(y, y)) - my * my;
    const cxy = mean(index(x, y)) - mx * my;
    return ((2 * mx * my + C1) * (2 * cxy + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2));
  }

  const mx = localMean(x, width, height);
  const my = localMean(y, width, height);
  const exx = localMean(index(x, x), width, height);
  const eyy = localMean(index(y, y), width, height);
  const exy = localMean(index(x, y), width, height);
  let total = 0;
  for (let i = 0; i < mx.length; i++) {
    const vx = exx[i]! - mx[i]! * mx[i]!;
    const vy = eyy[i]! - my[i]! * my[i]!;
    const cxy = exy[i]! - mx[i]! * my[i]!;
    total += ((2 * mx[i]! * my[i]! + C1) * (2 * cxy + C2)) / ((mx[i]! * mx[i]! + my[i]! * my[i]! + C1) * (vx + vy + C2));
  }
  return total / mx.length;
}

export interface ImageComparison {
  width: number;
  height: number;
  /** CIEDE2000 between corresponding pixels. */
  deltaE: { mean: number; p95: number; max: number };
  ssim: number;
}

/**
 * How different two pictures of the same size look: the colour difference at every pixel, summarised, and the structural
 * similarity of their lightness. Both are shrunk to `maxEdge` first (default 384), which is plenty for judging a look and keeps
 * a comparison to a fraction of a second.
 */
export function compareImages(a: Rgba, b: Rgba, opts: { maxEdge?: number } = {}): ImageComparison {
  assertSameSize(a, b);
  const maxEdge = opts.maxEdge ?? 384;
  const [x, y] = Math.max(a.width, a.height) > maxEdge ? [downscale(a, maxEdge), downscale(b, maxEdge)] : [a, b];
  const n = x.width * x.height;
  const diffs = new Float32Array(n);
  let sum = 0;
  for (let p = 0; p < n; p++) {
    const [l1, a1, b1] = srgbToLab(x.data[p * 4]!, x.data[p * 4 + 1]!, x.data[p * 4 + 2]!);
    const [l2, a2, b2] = srgbToLab(y.data[p * 4]!, y.data[p * 4 + 1]!, y.data[p * 4 + 2]!);
    diffs[p] = deltaE2000(l1, a1, b1, l2, a2, b2);
    sum += diffs[p]!;
  }
  const sorted = diffs.slice().sort();
  return {
    width: x.width,
    height: x.height,
    deltaE: { mean: sum / n, p95: sorted[Math.min(n - 1, Math.floor(0.95 * n))]!, max: sorted[n - 1]! },
    ssim: ssim(x, y),
  };
}
