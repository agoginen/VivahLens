import { describe, expect, it } from "vitest";
import { RecipeAdjustmentsSchema, type EditRecipe, type RecipeAdjustments } from "@vivahlens/core";
import { boxBlur, gaussianBlur } from "./blur.js";
import { illuminantRgb, type Rgba } from "./color.js";
import { cropGeometry, parseAspect } from "./geometry.js";
import { renderRecipe, RENDER_FIELDS, unrenderedFields } from "./render.js";
import { buildCurveLut, buildToneLut } from "./tone.js";

const recipe = (adjustments: RecipeAdjustments): EditRecipe => ({ version: "1.0", assetType: "photo", adjustments });

function image(w: number, h: number, pixel: (x: number, y: number) => [number, number, number]): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}
const solid = (rgb: [number, number, number], w = 8, h = 8) => image(w, h, () => rgb);
const at = (img: Rgba, x: number, y: number): [number, number, number] => {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
};
const centre = (img: Rgba) => at(img, img.width >> 1, img.height >> 1);
const lum = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const stdDev = (img: Rgba) => {
  let sum = 0;
  let sq = 0;
  const n = img.width * img.height;
  for (let p = 0; p < n; p++) {
    const v = lum([img.data[p * 4]!, img.data[p * 4 + 1]!, img.data[p * 4 + 2]!]);
    sum += v;
    sq += v * v;
  }
  return Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2));
};
const meanLum = (img: Rgba) => {
  let sum = 0;
  for (let p = 0; p < img.width * img.height; p++) sum += lum([img.data[p * 4]!, img.data[p * 4 + 1]!, img.data[p * 4 + 2]!]);
  return sum / (img.width * img.height);
};
const maxDiff = (a: Rgba, b: Rgba) => {
  let worst = 0;
  for (let i = 0; i < a.data.length; i++) worst = Math.max(worst, Math.abs(a.data[i]! - b.data[i]!));
  return worst;
};

describe("renderRecipe basics", () => {
  const ramp = image(64, 16, (x, y) => [x * 4, 255 - x * 4, (y * 16) % 256]);

  it("returns the picture as it was for a recipe that changes nothing, and never touches its input", () => {
    const before = Uint8Array.from(ramp.data);
    const out = renderRecipe(ramp, recipe({}));
    expect(out).not.toBe(ramp);
    expect(maxDiff(out, ramp)).toBeLessThanOrEqual(1);
    expect(Array.from(ramp.data)).toEqual(Array.from(before));
  });

  it("renders the same pixels every time", () => {
    const r = recipe({ exposure: 0.3, clarity: 20, grain: { amount: 30 }, vignette: { amount: -30 }, sharpening: { amount: 40 } });
    expect(renderRecipe(ramp, r).data).toEqual(renderRecipe(ramp, r).data);
  });

  it("accounts for every recipe field: each is drawn or reported, and the schema's photo fields are all known", () => {
    const photoFields = Object.keys(RecipeAdjustmentsSchema.shape).filter((f) => f !== "videoEdits");
    expect([...photoFields].sort()).toEqual([...RENDER_FIELDS, "lutRef"].sort());
    expect(unrenderedFields({ version: "1.0", assetType: "photo", adjustments: { lutRef: "warm.cube", exposure: 1, videoEdits: {} } })).toEqual(["lutRef", "videoEdits"]);
  });
});

describe("exposure and white balance", () => {
  const grey = solid([119, 119, 119]);

  it("doubles or halves the light per stop", () => {
    const up = centre(renderRecipe(grey, recipe({ exposure: 1 })))[0];
    expect(up).toBeGreaterThanOrEqual(163);
    expect(up).toBeLessThanOrEqual(165);
    expect(Math.abs(centre(renderRecipe(grey, recipe({ exposure: -1 })))[0] - 86)).toBeLessThanOrEqual(2);
    expect(centre(renderRecipe(solid([255, 255, 255]), recipe({ exposure: 2 })))).toEqual([255, 255, 255]);
  });

  it("warms the picture for a higher temperature and cools it for a lower one, keeping its brightness", () => {
    const warm = centre(renderRecipe(grey, recipe({ whiteBalance: { tempK: 8000 } })));
    const cool = centre(renderRecipe(grey, recipe({ whiteBalance: { tempK: 3500 } })));
    expect(warm[0]).toBeGreaterThan(warm[2] + 15);
    expect(cool[2]).toBeGreaterThan(cool[0] + 15);
    expect(Math.abs(lum(warm) - 119)).toBeLessThan(4);
    expect(Math.abs(lum(cool) - 119)).toBeLessThan(4);
    expect(centre(renderRecipe(grey, recipe({ whiteBalance: { tempK: 5500 } })))).toEqual([119, 119, 119]);
  });

  it("measures a temperature change from the as-shot temperature given, and moves toward magenta for positive tint", () => {
    const sameAsShot = renderRecipe(grey, recipe({ whiteBalance: { tempK: 6500 } }), { asShotTempK: 6500 });
    expect(centre(sameAsShot)).toEqual([119, 119, 119]);
    const magenta = centre(renderRecipe(grey, recipe({ whiteBalance: { tint: 100 } })));
    expect(magenta[1]).toBeLessThan(magenta[0] - 8);
    expect(magenta[1]).toBeLessThan(magenta[2] - 8);
  });

  it("models black-body light sensibly", () => {
    const [r65, , b65] = illuminantRgb(6500);
    expect(r65).toBeGreaterThan(0.85);
    expect(r65).toBeLessThan(1.2);
    expect(b65).toBeGreaterThan(0.85);
    const tungsten = illuminantRgb(2850);
    expect(tungsten[0] / tungsten[2]).toBeGreaterThan(2);
    let last = Infinity;
    for (const k of [2500, 3500, 4500, 5500, 6500, 8000, 10000]) {
      const [r, , b] = illuminantRgb(k);
      expect(r / b).toBeLessThan(last);
      last = r / b;
    }
  });
});

describe("tone", () => {
  const dark = solid([51, 51, 51]);
  const bright = solid([230, 230, 230]);
  const change = (img: Rgba, a: RecipeAdjustments) => centre(renderRecipe(img, recipe(a)))[0] - centre(img)[0];

  it("shadows lift or deepen the dark tones far more than the bright ones, and highlights the reverse", () => {
    expect(change(dark, { shadows: 100 })).toBeGreaterThan(20);
    expect(Math.abs(change(bright, { shadows: 100 }))).toBeLessThan(3);
    expect(change(dark, { shadows: -100 })).toBeLessThan(-8);
    expect(change(bright, { highlights: -100 })).toBeLessThan(-20);
    expect(Math.abs(change(dark, { highlights: -100 }))).toBeLessThan(3);
    expect(change(bright, { highlights: 100 })).toBeGreaterThan(5);
  });

  it("blacks and whites move the extremes", () => {
    expect(change(solid([15, 15, 15]), { blacks: 100 })).toBeGreaterThan(15);
    expect(change(solid([15, 15, 15]), { blacks: -100 })).toBeLessThan(-5);
    expect(change(solid([245, 245, 245]), { whites: -100 })).toBeLessThan(-15);
  });

  it("contrast spreads values away from the middle and negative contrast squeezes them toward it", () => {
    expect(change(dark, { contrast: 60 })).toBeLessThan(-8);
    expect(change(bright, { contrast: 60 })).toBeGreaterThan(5);
    expect(Math.abs(change(solid([128, 128, 128]), { contrast: 60 }))).toBeLessThan(3);
    expect(change(dark, { contrast: -60 })).toBeGreaterThan(8);
    expect(change(bright, { contrast: -60 })).toBeLessThan(-5);
  });

  it("keeps the colour of a coloured pixel when it changes the brightness", () => {
    const orange = solid([200, 120, 60]);
    const [r, g, b] = centre(renderRecipe(orange, recipe({ shadows: 100, contrast: 30 })));
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(r / b).toBeGreaterThan(2.2);
  });

  it("never makes a lighter tone darker than a darker one, whatever the sliders", () => {
    for (const s of [{ contrast: 100 }, { contrast: -100 }, { shadows: 100, highlights: -100 }, { blacks: 100, whites: -100, contrast: 50 }]) {
      const lut = buildToneLut(s)!;
      for (let i = 1; i < lut.length; i++) expect(lut[i]!, JSON.stringify(s)).toBeGreaterThanOrEqual(lut[i - 1]! - 1e-6);
    }
    expect(buildToneLut({})).toBeUndefined();
  });

  it("follows a tone curve smoothly without overshooting its points", () => {
    expect(buildCurveLut([{ input: 0, output: 0 }, { input: 255, output: 255 }])).toBeUndefined();
    const matte = centre(renderRecipe(solid([0, 0, 0]), recipe({ toneCurve: [{ input: 0, output: 40 }, { input: 255, output: 255 }] })));
    expect(matte[0]).toBeGreaterThanOrEqual(39);
    expect(matte[0]).toBeLessThanOrEqual(41);
    expect(centre(renderRecipe(solid([255, 255, 255]), recipe({ toneCurve: [{ input: 0, output: 40 }, { input: 255, output: 255 }] })))[0]).toBe(255);

    const lut = buildCurveLut([{ input: 64, output: 128 }, { input: 192, output: 160 }])!;
    for (let i = 1; i < 256; i++) expect(lut[i]!).toBeGreaterThanOrEqual(lut[i - 1]! - 1e-6);
    expect(Math.min(...lut)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...lut)).toBeLessThanOrEqual(1);
    expect(lut[64]! * 255).toBeCloseTo(128, 0);
    expect(lut[192]! * 255).toBeCloseTo(160, 0);
  });
});

describe("colour", () => {
  const chroma = ([r, g, b]: [number, number, number]) => Math.max(r, g, b) - Math.min(r, g, b);
  const orange = solid([200, 130, 70]);
  const blue = solid([60, 100, 200]);

  it("saturation -100 is grey, and positive saturation adds colour", () => {
    const grey = centre(renderRecipe(orange, recipe({ saturation: -100 })));
    expect(chroma(grey)).toBeLessThanOrEqual(1);
    expect(chroma(centre(renderRecipe(orange, recipe({ saturation: 40 }))))).toBeGreaterThan(chroma(centre(orange)) + 20);
  });

  it("vibrance adds more colour to a dull pixel than to a vivid one", () => {
    const dull = solid([120, 130, 140]);
    const vivid = solid([40, 60, 230]);
    const gain = (img: Rgba) => chroma(centre(renderRecipe(img, recipe({ vibrance: 100 })))) / chroma(centre(img));
    expect(gain(dull)).toBeGreaterThan(gain(vivid) + 0.3);
  });

  it("vibrance is gentler on skin tones than on other hues of the same strength", () => {
    const skin = solid([210, 160, 130]);
    const sky = solid([130, 160, 210]);
    const gain = (img: Rgba) => chroma(centre(renderRecipe(img, recipe({ vibrance: 100 })))) / chroma(centre(img));
    expect(gain(skin)).toBeLessThan(gain(sky));
  });

  it("a colour's own sliders change that colour and leave the others alone", () => {
    const desaturateOrange = recipe({ hsl: { orange: { saturation: -100 } } });
    expect(chroma(centre(renderRecipe(orange, desaturateOrange)))).toBeLessThan(chroma(centre(orange)) * 0.4);
    expect(maxDiff(renderRecipe(blue, desaturateOrange), blue)).toBeLessThanOrEqual(2);

    const darkenBlue = renderRecipe(blue, recipe({ hsl: { blue: { luminance: -100 } } }));
    expect(lum(centre(darkenBlue))).toBeLessThan(lum(centre(blue)) - 15);
    expect(maxDiff(renderRecipe(orange, recipe({ hsl: { blue: { luminance: -100 } } })), orange)).toBeLessThanOrEqual(2);

    const turnBlue = centre(renderRecipe(blue, recipe({ hsl: { blue: { hue: 100 } } })));
    expect(turnBlue[0]).toBeGreaterThan(centre(blue)[0] + 12);
  });

  it("leaves greys alone however far the colour sliders go", () => {
    const grey = solid([128, 128, 128]);
    expect(maxDiff(renderRecipe(grey, recipe({ hsl: { red: { saturation: 100, hue: 100 }, blue: { luminance: 100 } } })), grey)).toBeLessThanOrEqual(1);
  });

  it("split toning tints highlights and shadows with their own colours without changing brightness much", () => {
    const toned = recipe({ splitToning: { highlightHue: 40, highlightSaturation: 100, shadowHue: 220, shadowSaturation: 100, balance: 0 } });
    const light = centre(renderRecipe(solid([210, 210, 210]), toned));
    const shade = centre(renderRecipe(solid([40, 40, 40]), toned));
    expect(light[0]).toBeGreaterThan(light[2] + 10);
    expect(shade[2]).toBeGreaterThan(shade[0] + 10);
    expect(Math.abs(lum(light) - 210)).toBeLessThan(6);
    expect(Math.abs(lum(shade) - 40)).toBeLessThan(6);
  });

  it("split toning balance moves where highlights begin", () => {
    const tint = (balance: number) => centre(renderRecipe(solid([140, 140, 140]), recipe({ splitToning: { highlightHue: 0, highlightSaturation: 100, balance } })))[0];
    expect(tint(-100)).toBeGreaterThan(tint(100) + 5);
  });
});

describe("detail", () => {
  const edge = image(64, 32, (x) => (x < 32 ? [90, 90, 90] : [170, 170, 170]));
  const noisy = image(64, 64, (x, y) => {
    const n = ((x * 7919 + y * 104729) % 17) - 8;
    return [128 + n * 2, 128 + n * 2, 128 + n * 2];
  });

  it("clarity, texture and sharpening deepen an edge, and negative clarity and texture soften it", () => {
    for (const a of [{ clarity: 80 }, { texture: 80 }, { sharpening: { amount: 100, radius: 1.5 } }] as RecipeAdjustments[]) {
      const out = renderRecipe(edge, recipe(a));
      expect(at(out, 30, 16)[0], JSON.stringify(a)).toBeLessThan(90);
      expect(at(out, 34, 16)[0], JSON.stringify(a)).toBeGreaterThan(170);
    }
    for (const a of [{ clarity: -80 }, { texture: -80 }] as RecipeAdjustments[]) {
      const out = renderRecipe(edge, recipe(a));
      expect(at(out, 30, 16)[0], JSON.stringify(a)).toBeGreaterThan(90);
      expect(at(out, 34, 16)[0], JSON.stringify(a)).toBeLessThan(170);
    }
  });

  it("leaves flat areas alone", () => {
    const flat = solid([100, 120, 140], 32, 32);
    expect(maxDiff(renderRecipe(flat, recipe({ clarity: 100, texture: 100, sharpening: { amount: 150 } })), flat)).toBeLessThanOrEqual(1);
  });

  it("noise reduction smooths noise but keeps a real edge", () => {
    const smooth = renderRecipe(noisy, recipe({ noiseReduction: { luminance: 100, color: 50 } }));
    expect(stdDev(smooth)).toBeLessThan(stdDev(noisy) * 0.6);
    const edged = renderRecipe(edge, recipe({ noiseReduction: { luminance: 100 } }));
    expect(at(edged, 36, 16)[0] - at(edged, 28, 16)[0]).toBeGreaterThan(65);
  });

  it("noise reduction removes colour noise", () => {
    const speckle = image(48, 48, (x, y) => ((x + y) % 2 ? [150, 110, 130] : [110, 150, 130]));
    const out = renderRecipe(speckle, recipe({ noiseReduction: { color: 100 } }));
    const [r, g] = centre(out);
    expect(Math.abs(r - g)).toBeLessThan(8);
  });

  it("dehaze adds contrast to a hazy picture and a negative value veils it", () => {
    const hazy = image(48, 48, (x) => {
      const v = 150 + Math.round((x / 47) * 60);
      return [v, v, v + 10];
    });
    expect(stdDev(renderRecipe(hazy, recipe({ dehaze: 80 })))).toBeGreaterThan(stdDev(hazy) * 1.2);
    expect(at(renderRecipe(hazy, recipe({ dehaze: 80 })), 2, 20)[0]).toBeLessThan(at(hazy, 2, 20)[0] - 15);
    expect(at(renderRecipe(solid([40, 40, 40], 16, 16), recipe({ dehaze: -100 })), 8, 8)[0]).toBeGreaterThan(80);
  });

  it("vignette darkens the corners and not the middle, evenly on all four, and a positive amount lightens them", () => {
    const flat = solid([150, 150, 150], 120, 80);
    const dark = renderRecipe(flat, recipe({ vignette: { amount: -100 } }));
    expect(at(dark, 60, 40)[0]).toBeGreaterThanOrEqual(149);
    const corners = [at(dark, 0, 0)[0], at(dark, 119, 0)[0], at(dark, 0, 79)[0], at(dark, 119, 79)[0]];
    expect(Math.max(...corners)).toBeLessThan(110);
    expect(Math.max(...corners) - Math.min(...corners)).toBeLessThanOrEqual(1);
    expect(at(renderRecipe(flat, recipe({ vignette: { amount: 100 } })), 0, 0)[0]).toBeGreaterThan(180);
  });

  it("vignette roundness decides whether the long sides are touched as much as the short ones", () => {
    const flat = solid([150, 150, 150], 160, 80);
    const side = (roundness: number) => {
      const out = renderRecipe(flat, recipe({ vignette: { amount: -100, midpoint: 70, feather: 60, roundness } }));
      return { long: at(out, 0, 40)[0], short: at(out, 80, 0)[0] };
    };
    const oval = side(0);
    const circle = side(100);
    expect(circle.long).toBeLessThan(oval.long);
    expect(circle.short).toBeGreaterThan(oval.short);
  });

  it("grain is seeded, grows with amount, and keeps the average brightness", () => {
    const flat = solid([128, 128, 128], 64, 64);
    const light = renderRecipe(flat, recipe({ grain: { amount: 20 } }), { seed: 1 });
    const heavy = renderRecipe(flat, recipe({ grain: { amount: 80 } }), { seed: 1 });
    expect(stdDev(heavy)).toBeGreaterThan(stdDev(light) * 2);
    expect(Math.abs(meanLum(heavy) - 128)).toBeLessThan(2);
    expect(renderRecipe(flat, recipe({ grain: { amount: 50 } }), { seed: 1 }).data).toEqual(renderRecipe(flat, recipe({ grain: { amount: 50 } }), { seed: 1 }).data);
    expect(renderRecipe(flat, recipe({ grain: { amount: 50 } }), { seed: 1 }).data).not.toEqual(renderRecipe(flat, recipe({ grain: { amount: 50 } }), { seed: 2 }).data);
    expect(maxDiff(renderRecipe(flat, recipe({ grain: { amount: 0 } })), flat)).toBeLessThanOrEqual(1);
  });

  it("larger grain is coarser: neighbouring pixels agree more", () => {
    const flat = solid([128, 128, 128], 96, 96);
    const neighbours = (size: number) => {
      const out = renderRecipe(flat, recipe({ grain: { amount: 60, size, roughness: 0 } }), { seed: 3 });
      let agree = 0;
      let total = 0;
      for (let y = 0; y < 96; y++) {
        for (let x = 0; x < 95; x++) {
          agree += (at(out, x, y)[0] - 128) * (at(out, x + 1, y)[0] - 128);
          total += (at(out, x, y)[0] - 128) ** 2;
        }
      }
      return agree / total;
    };
    expect(neighbours(90)).toBeGreaterThan(neighbours(5) + 0.2);
  });
});

describe("blur", () => {
  it("keeps a flat plane flat, preserves the mean, and shrinks variance", () => {
    const flat = new Float32Array(30 * 20).fill(0.4);
    expect(Math.max(...boxBlur(flat, 30, 20, 3).map((v) => Math.abs(v - 0.4)))).toBeLessThan(1e-5);
    const noise = Float32Array.from({ length: 40 * 40 }, (_, i) => ((i * 2654435761) % 1000) / 1000);
    const blurred = gaussianBlur(noise, 40, 40, 2);
    const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length;
    const variance = (a: Float32Array) => a.reduce((s, v) => s + (v - mean(a)) ** 2, 0) / a.length;
    expect(Math.abs(mean(blurred) - mean(noise))).toBeLessThan(0.02);
    expect(variance(blurred)).toBeLessThan(variance(noise) * 0.2);
  });
});

describe("crop, straighten and resize", () => {
  const ramp = image(200, 100, (x, y) => [Math.round((x / 199) * 255), Math.round((y / 99) * 255), 0]);

  it("cuts the rectangle asked for, in fractions of the source", () => {
    const out = renderRecipe(ramp, recipe({ crop: { x: 0.25, y: 0.5, width: 0.5, height: 0.5 } }));
    expect([out.width, out.height]).toEqual([100, 50]);
    expect(at(out, 0, 0)[0]).toBeGreaterThanOrEqual(Math.round((50 / 199) * 255) - 2);
    expect(at(out, 0, 0)[0]).toBeLessThanOrEqual(Math.round((50 / 199) * 255) + 2);
    expect(at(out, 0, 0)[1]).toBeGreaterThan(120);
  });

  it("cuts to an aspect ratio from the middle, and understands the usual spellings", () => {
    expect([renderRecipe(ramp, recipe({ crop: { aspectRatio: "1:1" } })).width, renderRecipe(ramp, recipe({ crop: { aspectRatio: "1:1" } })).height]).toEqual([100, 100]);
    expect(parseAspect("16x9", 1, 1)).toBeCloseTo(16 / 9);
    expect(parseAspect("original", 300, 200)).toBeCloseTo(1.5);
    expect(parseAspect("1.5", 1, 1)).toBe(1.5);
    expect(parseAspect("wide", 1, 1)).toBeUndefined();
    expect(parseAspect("0:5", 1, 1)).toBeUndefined();
    expect(cropGeometry(200, 100, {})).toBeUndefined();
    expect(cropGeometry(200, 100, { aspectRatio: "nonsense" })).toBeUndefined();
  });

  it("straightening trims to the largest same-shaped rectangle so no empty corner shows", () => {
    const framed = image(300, 200, (x, y) => (x < 3 || y < 3 || x >= 297 || y >= 197 ? [255, 0, 0] : [90, 90, 90]));
    const out = renderRecipe(framed, recipe({ crop: { rotationDeg: 3 } }));
    expect(out.width).toBeLessThan(300);
    expect(out.width / out.height).toBeCloseTo(1.5, 1);
    // The trimmed picture only just reaches the frame's edge at its corners; without trimming, whole edges of the red border would be repeated into view.
    let red = 0;
    for (let p = 0; p < out.width * out.height; p++) if (out.data[p * 4]! > 100) red++;
    expect(red).toBeLessThan(out.width * out.height * 0.005);
    const untrimmed = renderRecipe(framed, recipe({ crop: { x: 0, y: 0, width: 1, height: 1, rotationDeg: 3 } }));
    let repeated = 0;
    for (let p = 0; p < untrimmed.width * untrimmed.height; p++) if (untrimmed.data[p * 4]! > 100) repeated++;
    expect(repeated).toBeGreaterThan(untrimmed.width * untrimmed.height * 0.02);
    const geometry = cropGeometry(300, 200, { rotationDeg: 3 })!;
    expect(geometry.width).toBeCloseTo(300 / (Math.cos(0.0524) + 1.5 * Math.sin(0.0524)), 0);
  });

  it("turns the picture clockwise for a positive angle", () => {
    const square = image(200, 200, (x, y) => (x >= 170 && y <= 30 ? [255, 255, 255] : [0, 0, 0]));
    const out = renderRecipe(square, recipe({ crop: { x: 0, y: 0, width: 1, height: 1, rotationDeg: 90 } }));
    expect(at(out, 180, 180)[0]).toBeGreaterThan(200);
    expect(at(out, 180, 20)[0]).toBeLessThan(50);
  });

  it("shrinks to a maximum edge without enlarging, and keeps sharpening in proportion", () => {
    const big = image(400, 200, (x) => (x < 200 ? [90, 90, 90] : [170, 170, 170]));
    const small = renderRecipe(big, recipe({ sharpening: { amount: 100, radius: 2 } }), { maxEdge: 100 });
    expect([small.width, small.height]).toEqual([100, 50]);
    expect(renderRecipe(big, recipe({}), { maxEdge: 1000 }).width).toBe(400);
    expect(at(small, 48, 25)[0]).toBeLessThan(95);
    expect(at(small, 52, 25)[0]).toBeGreaterThan(165);
  });
});

describe("speed", () => {
  it("renders a 1.7 megapixel preview with a rich recipe in a few seconds", () => {
    const big = image(1600, 1067, (x, y) => [(x * 7 + y) % 256, (x + y * 3) % 256, (x * y) % 256]);
    const rich = recipe({
      exposure: 0.4, whiteBalance: { tempK: 6200, tint: 5 }, highlights: -30, shadows: 25, contrast: 10, vibrance: 15, saturation: 5, clarity: 15, texture: 10, dehaze: 10,
      hsl: { orange: { hue: 5, luminance: -8 } }, splitToning: { highlightHue: 40, highlightSaturation: 10, shadowHue: 220, shadowSaturation: 10 },
      toneCurve: [{ input: 0, output: 8 }, { input: 255, output: 255 }], noiseReduction: { luminance: 20, color: 25 }, sharpening: { amount: 40, radius: 1 },
      vignette: { amount: -15 }, grain: { amount: 15 },
    });
    const started = Date.now();
    const out = renderRecipe(big, rich);
    expect(out.width).toBe(1600);
    // A guard against a pass that goes quadratic or worse, not a speed target: a busy machine takes several times longer than an idle one.
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 90_000);
});
