import { describe, expect, it } from "vitest";
import type { EditRecipe } from "../recipe/editRecipe.js";
import { profileFromRecipes } from "./profileFromRecipes.js";

const r = (adjustments: EditRecipe["adjustments"]): EditRecipe => ({ version: "1.0", assetType: "photo", adjustments });

describe("profileFromRecipes", () => {
  it("takes the median of settings the photographer actually uses", () => {
    const profile = profileFromRecipes(
      [
        r({ exposure: 0.2, contrast: 10, hsl: { orange: { luminance: -10 } } }),
        r({ exposure: 0.4, contrast: 14, hsl: { orange: { luminance: -6 } } }),
        r({ exposure: 3, contrast: 12, hsl: { orange: { luminance: -8 } } }),
      ],
      { id: "mine", name: "Mine" },
    );
    expect(profile.baseAdjustments).toEqual({ exposure: 0.4, contrast: 12, hsl: { orange: { luminance: -8 } } });
    expect(profile.summary).toContain("3 finished edit(s)");
    expect(profile.version).toBe(1);
  });

  it("drops rarely-used settings and untouched (zero-median) sliders", () => {
    const edits = [
      r({ exposure: 0.5, contrast: 0, vibrance: 30 }),
      r({ exposure: 0.5, contrast: 0 }),
      r({ exposure: 0.5, contrast: 0 }),
      r({ exposure: 0.5 }),
      r({ exposure: 0.5 }),
    ];
    expect(profileFromRecipes(edits, { id: "p", name: "P" }).baseAdjustments).toEqual({ exposure: 0.5 });
  });

  it("rejects an empty edit set", () => {
    expect(() => profileFromRecipes([], { id: "p", name: "P" })).toThrow(/zero edits/);
  });
});
