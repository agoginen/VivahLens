import { describe, expect, it } from "vitest";
import type { Rgba } from "./color.js";
import { compareImages, deltaE2000, srgbToLab, ssim } from "./metrics.js";

// Sharma, Wu and Dalal (2005), "The CIEDE2000 Color-Difference Formula: Implementation Notes, Supplementary Test Data, and
// Mathematical Observations": the 34 pairs they publish for checking an implementation. [L1, a1, b1, L2, a2, b2, CIEDE2000].
const SHARMA: [number, number, number, number, number, number, number][] = [
  [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
  [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
  [50, 2.8361, -74.02, 50, 0, -82.7485, 3.4412],
  [50, -1.3802, -84.2814, 50, 0, -82.7485, 1],
  [50, -1.1848, -84.8006, 50, 0, -82.7485, 1],
  [50, -0.9009, -85.5211, 50, 0, -82.7485, 1],
  [50, 0, 0, 50, -1, 2, 2.3669],
  [50, -1, 2, 50, 0, 0, 2.3669],
  [50, 2.49, -0.001, 50, -2.49, 0.0009, 7.1792],
  [50, 2.49, -0.001, 50, -2.49, 0.001, 7.1792],
  [50, 2.49, -0.001, 50, -2.49, 0.0011, 7.2195],
  [50, 2.49, -0.001, 50, -2.49, 0.0012, 7.2195],
  [50, -0.001, 2.49, 50, 0.0009, -2.49, 4.8045],
  [50, -0.001, 2.49, 50, 0.001, -2.49, 4.8045],
  [50, -0.001, 2.49, 50, 0.0011, -2.49, 4.7461],
  [50, 2.5, 0, 50, 0, -2.5, 4.3065],
  [50, 2.5, 0, 73, 25, -18, 27.1492],
  [50, 2.5, 0, 61, -5, 29, 22.8977],
  [50, 2.5, 0, 56, -27, -3, 31.903],
  [50, 2.5, 0, 58, 24, 15, 19.4535],
  [50, 2.5, 0, 50, 3.1736, 0.5854, 1],
  [50, 2.5, 0, 50, 3.2972, 0, 1],
  [50, 2.5, 0, 50, 1.8634, 0.5757, 1],
  [50, 2.5, 0, 50, 3.2592, 0.335, 1],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
  [36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
];

const solid = (width: number, height: number, [r, g, b]: [number, number, number]): Rgba => {
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) data.set([r, g, b, 255], p * 4);
  return { width, height, data };
};

/** A textured picture, the same every time for the same seed. */
function texture(seed: number, width = 48, height = 40, noise = 0): Rgba {
  let state = seed * 2654435761 + 1;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = 128 + 60 * Math.sin((x / width) * 9 + seed) * Math.cos((y / height) * 7);
      for (let c = 0; c < 3; c++) data[(y * width + x) * 4 + c] = Math.max(0, Math.min(255, Math.round(base + c * 6 + (random() - 0.5) * noise)));
      data[(y * width + x) * 4 + 3] = 255;
    }
  }
  return { width, height, data };
}

describe("srgbToLab", () => {
  it("gives black and white", () => {
    expect(srgbToLab(0, 0, 0)).toEqual([0, 0, 0]);
    const [l, a, b] = srgbToLab(255, 255, 255);
    expect(l).toBeCloseTo(100, 3);
    expect(Math.abs(a)).toBeLessThan(0.02);
    expect(Math.abs(b)).toBeLessThan(0.02);
  });

  it("gives the well-known values for the sRGB primaries under D65", () => {
    const close = (got: number[], want: number[]) => got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 1));
    close(srgbToLab(255, 0, 0), [53.2408, 80.0925, 67.2032]);
    close(srgbToLab(0, 255, 0), [87.7347, -86.1827, 83.1793]);
    close(srgbToLab(0, 0, 255), [32.297, 79.1875, -107.8602]);
  });

  it("puts a mid grey at about L* 50, with no colour", () => {
    const [l, a, b] = srgbToLab(119, 119, 119);
    expect(l).toBeCloseTo(50, 0);
    expect(Math.abs(a) + Math.abs(b)).toBeLessThan(0.05);
  });
});

describe("deltaE2000", () => {
  it.each(SHARMA.map((row, i) => [i + 1, ...row] as const))("agrees with the published value for Sharma pair %i", (_pair, L1, a1, b1, L2, a2, b2, expected) => {
    expect(deltaE2000(L1, a1, b1, L2, a2, b2)).toBeCloseTo(expected, 4);
  });

  it("is the same whichever colour comes first", () => {
    for (const [L1, a1, b1, L2, a2, b2] of SHARMA) expect(deltaE2000(L2, a2, b2, L1, a1, b1)).toBeCloseTo(deltaE2000(L1, a1, b1, L2, a2, b2), 9);
  });

  it("is zero for the same colour, grey or not", () => {
    expect(deltaE2000(50, 0, 0, 50, 0, 0)).toBe(0);
    expect(deltaE2000(63, -31, -6, 63, -31, -6)).toBe(0);
  });
});

/** SSIM straight from its definition, window by window, as a check on the faster separable version. */
function bruteSsim(a: Rgba, b: Rgba): number {
  const size = 11;
  const raw = Array.from({ length: size }, (_, i) => Math.exp(-((i - 5) ** 2) / (2 * 1.5 * 1.5)));
  const k = raw.map((v) => v / raw.reduce((s, e) => s + e, 0));
  const lum = (img: Rgba, x: number, y: number) => 0.2126 * img.data[(y * img.width + x) * 4]! + 0.7152 * img.data[(y * img.width + x) * 4 + 1]! + 0.0722 * img.data[(y * img.width + x) * 4 + 2]!;
  const [c1, c2] = [(0.01 * 255) ** 2, (0.03 * 255) ** 2];
  let total = 0;
  let windows = 0;
  for (let y0 = 0; y0 + size <= a.height; y0++) {
    for (let x0 = 0; x0 + size <= a.width; x0++) {
      let mx = 0;
      let my = 0;
      for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) (mx += k[i]! * k[j]! * lum(a, x0 + i, y0 + j)), (my += k[i]! * k[j]! * lum(b, x0 + i, y0 + j));
      let vx = 0;
      let vy = 0;
      let cxy = 0;
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
          const w = k[i]! * k[j]!;
          const [dx, dy] = [lum(a, x0 + i, y0 + j) - mx, lum(b, x0 + i, y0 + j) - my];
          vx += w * dx * dx;
          vy += w * dy * dy;
          cxy += w * dx * dy;
        }
      }
      total += ((2 * mx * my + c1) * (2 * cxy + c2)) / ((mx * mx + my * my + c1) * (vx + vy + c2));
      windows++;
    }
  }
  return total / windows;
}

describe("ssim", () => {
  it("is 1 for identical pictures and agrees with the definition, window by window, for different ones", () => {
    const base = texture(3);
    expect(ssim(base, base)).toBeCloseTo(1, 12);
    for (const [other, label] of [[texture(3, 48, 40, 40), "noisy copy"], [texture(9), "different picture"], [texture(5, 33, 29, 10), "odd size"]] as const) {
      const a = label === "odd size" ? texture(5, 33, 29) : base;
      expect(ssim(a, other), label).toBeCloseTo(bruteSsim(a, other), 9);
    }
  });

  it("is the same whichever picture comes first", () => {
    const [a, b] = [texture(1), texture(2, 48, 40, 30)];
    expect(ssim(a, b)).toBeCloseTo(ssim(b, a), 12);
  });

  it("for two flat pictures is the luminance term alone", () => {
    const [c1] = [(0.01 * 255) ** 2];
    const lum = (v: number) => 0.2126 * v + 0.7152 * v + 0.0722 * v;
    const expected = (2 * lum(100) * lum(150) + c1) / (lum(100) ** 2 + lum(150) ** 2 + c1);
    expect(ssim(solid(24, 24, [100, 100, 100]), solid(24, 24, [150, 150, 150]))).toBeCloseTo(expected, 10);
  });

  it("falls as more noise is added, and goes negative for a picture turned inside out", () => {
    const base = texture(4, 64, 48);
    const scores = [0, 20, 60, 140].map((n) => ssim(base, texture(4, 64, 48, n)));
    expect(scores[0]).toBeCloseTo(1, 9);
    for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeLessThan(scores[i - 1]!);
    const inverted: Rgba = { ...base, data: base.data.map((v, i) => (i % 4 === 3 ? v : 255 - v)) };
    expect(ssim(base, inverted)).toBeLessThan(0);
  });

  it("copes with a picture smaller than a window, as a whole", () => {
    const small = texture(1, 8, 8);
    expect(ssim(small, small)).toBeCloseTo(1, 12);
    const other = ssim(small, texture(2, 8, 8, 60));
    expect(other).toBeLessThan(1);
    expect(other).toBeGreaterThan(-1);
  });

  it("refuses pictures of different sizes", () => {
    expect(() => ssim(texture(1, 20, 20), texture(1, 21, 20))).toThrow(/differ in size/);
  });
});

describe("compareImages", () => {
  it("finds nothing between a picture and itself", () => {
    const r = compareImages(texture(6, 60, 50), texture(6, 60, 50));
    expect(r.deltaE).toEqual({ mean: 0, p95: 0, max: 0 });
    expect(r.ssim).toBeCloseTo(1, 12);
  });

  it("measures a uniform change as the colour difference of the two colours", () => {
    const r = compareImages(solid(30, 20, [100, 120, 140]), solid(30, 20, [110, 130, 150]));
    const expected = deltaE2000(...srgbToLab(100, 120, 140), ...srgbToLab(110, 130, 150));
    expect(expected).toBeGreaterThan(1);
    expect(r.deltaE.mean).toBeCloseTo(expected, 4);
    expect(r.deltaE.p95).toBeCloseTo(expected, 4);
    expect(r.deltaE.max).toBeCloseTo(expected, 4);
  });

  it("reports the mean, the 95th percentile and the worst pixel separately", () => {
    const a = solid(40, 40, [120, 120, 120]);
    const b: Rgba = { ...a, data: a.data.slice() };
    // The left 6 of 40 columns (15%) differ, so the 95th percentile falls among the differing pixels and the mean is 15% of it.
    for (let y = 0; y < 40; y++) for (let x = 0; x < 6; x++) b.data.set([160, 120, 120, 255], (y * 40 + x) * 4);
    const r = compareImages(a, b);
    const full = deltaE2000(...srgbToLab(120, 120, 120), ...srgbToLab(160, 120, 120));
    expect(r.deltaE.max).toBeCloseTo(full, 4);
    expect(r.deltaE.p95).toBeCloseTo(full, 4);
    expect(r.deltaE.mean).toBeCloseTo(full * 0.15, 3);
  });

  it("shrinks a large picture before comparing, and says to what", () => {
    const r = compareImages(texture(1, 800, 600), texture(1, 800, 600, 30), { maxEdge: 200 });
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(200);
    expect(r.width / r.height).toBeCloseTo(800 / 600, 1);
    expect(compareImages(texture(1, 100, 80), texture(1, 100, 80)).width).toBe(100);
  });

  it("refuses pictures of different sizes", () => {
    expect(() => compareImages(texture(1, 20, 20), texture(1, 20, 22))).toThrow(/differ in size/);
  });
});
