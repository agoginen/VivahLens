import { describe, expect, it } from "vitest";
import { canonicalJson, recipeHash } from "./hash.js";
import { CURRENT_RECIPE_VERSION, compareVersions, migrateRecipe, type RecipeConverter } from "./migrate.js";

describe("recipeHash", () => {
  it("is the same for equal recipes however their keys were ordered, and differs when a value differs", () => {
    const a = { version: "1.0", assetType: "photo", adjustments: { exposure: 0.5, whiteBalance: { tempK: 5200, tint: 4 } } };
    const b = { adjustments: { whiteBalance: { tint: 4, tempK: 5200 }, exposure: 0.5 }, assetType: "photo", version: "1.0" };

    expect(recipeHash(a)).toBe(recipeHash(b));
    expect(recipeHash(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(recipeHash({ ...a, adjustments: { ...a.adjustments, exposure: 0.6 } })).not.toBe(recipeHash(a));
  });

  it("keeps array order, because order is meaningful there", () => {
    expect(canonicalJson({ steps: [2, 1] })).toBe('{"steps":[2,1]}');
    expect(recipeHash({ steps: [1, 2] })).not.toBe(recipeHash({ steps: [2, 1] }));
  });
});

describe("compareVersions", () => {
  it("orders numerically, not as text", () => {
    expect(compareVersions("1.10", "1.9")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.9", "1.0")).toBe(-1);
  });
});

describe("migrateRecipe", () => {
  const current = { version: CURRENT_RECIPE_VERSION, assetType: "photo", adjustments: { exposure: 1 } };
  // Pretend 0.9 stored exposure in stops under another name, and 1.0 renamed it.
  const converters: RecipeConverter[] = [
    { from: "0.8", to: "0.9", convert: (r) => ({ ...r, adjustments: { exposureStops: (r.adjustments as { ev: number }).ev } }) },
    { from: "0.9", to: "1.0", convert: (r) => ({ ...r, adjustments: { exposure: (r.adjustments as { exposureStops: number }).exposureStops } }) },
  ];

  it("returns a current recipe unchanged after validating it", () => {
    expect(migrateRecipe(current)).toEqual(current);
    expect(() => migrateRecipe({ ...current, adjustments: { exposure: 99 } })).toThrow();
  });

  it("walks the converters one version at a time, so an old recipe stays usable", () => {
    const old = { version: "0.8", assetType: "photo", adjustments: { ev: 0.75 } };
    expect(migrateRecipe(old, converters, "1.0")).toEqual({ version: "1.0", assetType: "photo", adjustments: { exposure: 0.75 } });
  });

  it("explains a recipe from a newer app, one with no way forward, and a converter loop", () => {
    expect(() => migrateRecipe({ ...current, version: "2.0" })).toThrow(/newer than this app understands.*update the app/);
    expect(() => migrateRecipe({ ...current, version: "0.1" })).toThrow(/No converter from recipe version 0\.1/);
    const loop: RecipeConverter[] = [{ from: "0.1", to: "0.2", convert: (r) => r }, { from: "0.2", to: "0.1", convert: (r) => r }];
    expect(() => migrateRecipe({ ...current, version: "0.1" }, loop, "1.0")).toThrow(/loop/);
    expect(() => migrateRecipe("nope")).toThrow(/must be an object/);
  });
});
