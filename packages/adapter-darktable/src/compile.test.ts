import { describe, expect, it } from "vitest";
import type { EditRecipe } from "@vivahlens/core";
import { compileToHistory, SUPPORTED_FIELDS } from "./compile.js";
import { readCrop, readExposure } from "./params.js";

const recipe = (adjustments: EditRecipe["adjustments"]): EditRecipe => ({ version: "1.0", assetType: "photo", adjustments });
const compile = (adjustments: EditRecipe["adjustments"]) => compileToHistory(recipe(adjustments));

describe("exposure", () => {
  it("is added to darktable's own default lift, so a recipe's +0.35 EV lands at +1.05", () => {
    const { entries } = compile({ exposure: 0.35 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ operation: "exposure", modversion: 7 });
    expect(readExposure(entries[0]!.params)!.exposure).toBeCloseTo(1.05, 5);
    expect(readExposure(compile({ exposure: -1.5 }).entries[0]!.params)!.exposure).toBeCloseTo(-0.8, 5);
  });

  it("writes no entry for no change, so darktable's default look is left as it is", () => {
    expect(compile({}).entries).toEqual([]);
    expect(compile({ exposure: 0 }).entries).toEqual([]);
  });

  it("stays inside the range darktable's slider allows", () => {
    expect(readExposure(compile({ exposure: 5 }).entries[0]!.params)!.exposure).toBeCloseTo(5.7, 5);
    expect(readExposure(compile({ exposure: 500 } as never).entries[0]!.params)!.exposure).toBe(18);
    expect(readExposure(compile({ exposure: -500 } as never).entries[0]!.params)!.exposure).toBe(-18);
  });
});

describe("crop", () => {
  const rect = (adjustments: EditRecipe["adjustments"]) => {
    const e = compile(adjustments).entries.find((x) => x.operation === "crop");
    return e && readCrop(e.params);
  };

  it("turns a rectangle of fractions from the top left into darktable's left, top, right and bottom edges", () => {
    const r = rect({ crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } })!;
    expect(r.left).toBeCloseTo(0.1, 6);
    expect(r.top).toBeCloseTo(0.2, 6);
    expect(r.right).toBeCloseTo(0.6, 6);
    expect(r.bottom).toBeCloseTo(0.8, 6);
    expect(compile({ crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } }).entries[0]).toMatchObject({ operation: "crop", modversion: 3 });
  });

  it("fills in what the recipe leaves out: from the corner, or to the far edge", () => {
    expect(rect({ crop: { x: 0.25 } })).toMatchObject({ left: 0.25, top: 0, right: 1, bottom: 1 });
    expect(rect({ crop: { width: 0.8, height: 0.9 } })).toMatchObject({ left: 0, top: 0 });
    expect(rect({ crop: { width: 0.8 } })!.right).toBeCloseTo(0.8, 6);
  });

  it("keeps a rectangle that runs past the picture inside it", () => {
    expect(rect({ crop: { x: 0.6, y: -0.2, width: 0.9, height: 0.5 } })).toMatchObject({ left: expect.closeTo(0.6, 6), top: 0, right: 1, bottom: expect.closeTo(0.3, 6) });
  });

  it("writes nothing for the whole picture, and warns about a crop too small to be real", () => {
    expect(compile({ crop: { x: 0, y: 0, width: 1, height: 1 } }).entries).toEqual([]);
    const tiny = compile({ crop: { x: 0.5, y: 0.5, width: 0.02, height: 0.5 } });
    expect(tiny.entries).toEqual([]);
    expect(tiny.warnings).toEqual(["The crop was too small to be real, so it was not applied"]);
  });

  it("says what it could not do: a ratio with no rectangle, and straightening", () => {
    expect(compile({ crop: { aspectRatio: "4:5" } })).toEqual({ entries: [], warnings: ["An aspect ratio (4:5) without a crop rectangle was not applied: darktable needs the rectangle"] });
    const rotated = compile({ crop: { x: 0.1, width: 0.5, rotationDeg: 1.5 } });
    expect(rotated.entries).toHaveLength(1);
    expect(rotated.warnings).toEqual(["Straightening by 1.5° was not applied: darktable's crop module cannot rotate"]);
    expect(compile({ crop: { x: 0.1, width: 0.5, rotationDeg: 0 } }).warnings).toEqual([]);
  });
});

describe("everything else", () => {
  it("is not written, and the fields this adapter honours are exactly exposure and crop", () => {
    const { entries } = compile({ contrast: 20, saturation: 10, whiteBalance: { tempK: 4800, tint: 5 }, highlights: -30, hsl: { orange: { hue: 3 } } });
    expect(entries).toEqual([]);
    expect([...SUPPORTED_FIELDS]).toEqual(["exposure", "crop"]);
  });

  it("puts exposure before crop", () => {
    expect(compile({ crop: { x: 0.1, width: 0.5 }, exposure: 0.2 }).entries.map((e) => e.operation)).toEqual(["exposure", "crop"]);
  });
});
