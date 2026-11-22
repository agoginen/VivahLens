import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EditRecipe } from "@vivahlens/core";
import { buildXmp, compileToCrs, compileToCrsSettings } from "./compile.js";
import { readXmpEdits } from "./ingestEdits.js";
import { parseCrsToRecipe } from "./parse.js";

const recipe: EditRecipe = {
  version: "1.0",
  assetType: "photo",
  adjustments: {
    exposure: 0.35,
    contrast: -12,
    highlights: -40,
    shadows: 25,
    vibrance: 10,
    whiteBalance: { tempK: 5200, tint: 4 },
    hsl: { orange: { hue: 5, luminance: -8 } },
    splitToning: { highlightHue: 40, highlightSaturation: 20, balance: -10 },
    noiseReduction: { luminance: 20 },
    sharpening: { amount: 40, radius: 1.2 },
  },
};

describe("parseCrsToRecipe", () => {
  it("round-trips what the adapter writes", () => {
    const xmp = buildXmp(compileToCrsSettings(recipe));
    expect(parseCrsToRecipe(xmp)).toEqual(recipe);
  });

  it("round-trips the extended settings: clarity, texture, dehaze, vignette, grain, tone curve and crop", () => {
    const extended: EditRecipe = {
      version: "1.0",
      assetType: "photo",
      adjustments: {
        exposure: 0.2,
        clarity: 12,
        texture: -8,
        dehaze: 15,
        vignette: { amount: -20, midpoint: 40, feather: 60, roundness: 5 },
        grain: { amount: 18, size: 25, roughness: 50 },
        toneCurve: [{ input: 0, output: 0 }, { input: 64, output: 57 }, { input: 192, output: 200 }, { input: 255, output: 255 }],
        crop: { x: 0.05, y: 0.1, width: 0.8, height: 0.7, rotationDeg: 1.5 },
      },
    };
    const { attributes, sequences } = compileToCrs(extended);
    expect(parseCrsToRecipe(buildXmp(attributes, sequences))).toEqual(extended);
  });

  it("reads a curve Lightroom wrote, ignores a straight one, and a crop that is not turned on", () => {
    const lightroomCurve = `<rdf:Description xmlns:crs="x" crs:HasSettings="True" crs:HasCrop="False" crs:CropLeft="0.1" crs:CropTop="0.1" crs:CropRight="0.9" crs:CropBottom="0.9">
  <crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>71, 60</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012></rdf:Description>`;
    const parsed = parseCrsToRecipe(lightroomCurve)!;
    expect(parsed.adjustments.toneCurve).toEqual([{ input: 0, output: 0 }, { input: 71, output: 60 }, { input: 255, output: 255 }]);
    expect(parsed.adjustments.crop).toBeUndefined();

    const straight = `<rdf:Description xmlns:crs="x" crs:HasSettings="True"><crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012></rdf:Description>`;
    expect(parseCrsToRecipe(straight)!.adjustments.toneCurve).toBeUndefined();
  });

  it("ignores as-shot white balance and clamps out-of-range values", () => {
    const xmp = `<rdf:Description xmlns:crs="x" crs:HasSettings="True" crs:WhiteBalance="As Shot" crs:Temperature="6500" crs:Exposure2012="+9.00" crs:Contrast2012="-250"/>`;
    expect(parseCrsToRecipe(xmp)!.adjustments).toEqual({ exposure: 5, contrast: -100 });
  });

  it("reads element-form settings and returns undefined for files without develop settings", () => {
    const withElements = `<rdf:Description xmlns:crs="x" crs:HasSettings="True"><crs:Exposure2012>+0.50</crs:Exposure2012></rdf:Description>`;
    expect(parseCrsToRecipe(withElements)!.adjustments.exposure).toBe(0.5);
    expect(parseCrsToRecipe(`<rdf:Description xmp:Rating="4"/>`)).toBeUndefined();
  });
});

describe("readXmpEdits", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vivah-xmpdir-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("collects usable edits and skips the rest", async () => {
    writeFileSync(path.join(dir, "a.xmp"), buildXmp(compileToCrsSettings(recipe)));
    writeFileSync(path.join(dir, "rating-only.xmp"), `<x:xmpmeta><rdf:Description xmp:Rating="4"/></x:xmpmeta>`);
    writeFileSync(path.join(dir, "notes.txt"), "ignored");
    const { edits, skipped } = await readXmpEdits(dir);
    expect(edits.map((e) => path.basename(e.file))).toEqual(["a.xmp"]);
    expect(skipped).toEqual(["rating-only.xmp"]);
  });
});
