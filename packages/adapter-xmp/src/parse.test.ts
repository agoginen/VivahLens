import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EditRecipe } from "@vivahlens/core";
import { buildXmp, compileToCrsSettings } from "./compile.js";
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
