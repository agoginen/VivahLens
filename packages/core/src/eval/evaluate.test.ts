import { describe, expect, it } from "vitest";
import type { EditRecipe } from "../recipe/editRecipe.js";
import { compareRecipes, evaluateRecipes } from "./evaluate.js";

const r = (adjustments: EditRecipe["adjustments"]): EditRecipe => ({ version: "1.0", assetType: "photo", adjustments });

describe("compareRecipes", () => {
  it("accepts proposals within tolerance and treats a missing slider as zero", () => {
    expect(compareRecipes(r({ exposure: 0.5, contrast: 10 }), r({ exposure: 0.7, contrast: 4 })).accepted).toBe(true);
    expect(compareRecipes(r({ exposure: 0.5 }), r({ exposure: 0.5, contrast: 40 })).accepted).toBe(false);
  });

  it("flags large misses, missing white balance and ignores white balance the photographer did not set", () => {
    const miss = compareRecipes(r({ exposure: 0.5 }), r({ exposure: 1.2 }));
    expect(miss.deviations.find((d) => d.path === "exposure")).toMatchObject({ withinTolerance: false });

    const noWb = compareRecipes(r({ whiteBalance: { tempK: 5200 } }), r({ exposure: 0 }));
    expect(noWb.accepted).toBe(false);
    expect(compareRecipes(r({ exposure: 0.2 }), r({ exposure: 0.2, whiteBalance: { tempK: 3000 } })).accepted).toBe(true);
  });
});

describe("evaluateRecipes", () => {
  it("reports acceptance and schema-valid rates with per-field error", () => {
    const expected = r({ exposure: 0.5, contrast: 10 });
    const report = evaluateRecipes([
      { id: "good", expected, actual: r({ exposure: 0.6, contrast: 12 }) },
      { id: "off", expected, actual: r({ exposure: 2, contrast: 10 }) },
      { id: "garbage", expected, actual: { adjustments: { exposure: 99 } } },
      { id: "missing", expected, actual: undefined },
    ]);
    expect(report).toMatchObject({ total: 4, schemaValid: 2, accepted: 1, acceptanceRate: 0.25, schemaValidRate: 0.5 });
    expect(report.perField.exposure).toMatchObject({ compared: 2, withinTolerance: 1 });
    expect(report.perField.exposure!.meanAbsDelta).toBeCloseTo(0.8);
    expect(report.cases.map((c) => [c.id, c.accepted])).toEqual([["good", true], ["off", false], ["garbage", false], ["missing", false]]);
  });

  it("handles an empty set", () => {
    expect(evaluateRecipes([])).toMatchObject({ total: 0, acceptanceRate: 0, schemaValidRate: 0 });
  });
});
