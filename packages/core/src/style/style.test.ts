import { describe, expect, it } from "vitest";
import type { EditRecipe } from "../recipe/editRecipe.js";
import { findOutliers } from "./consistency.js";
import { clusterScenes } from "./sceneCluster.js";
import { learnFromOverrides, styleLineage, StyleProfileSchema, versionAfter, type StyleProfile } from "./styleProfile.js";

const recipe = (exposure: number): EditRecipe => ({ version: "1.0", assetType: "photo", adjustments: { exposure } });

describe("learnFromOverrides", () => {
  const profile: StyleProfile = { id: "p", name: "Warm", version: 1, summary: "", baseAdjustments: { exposure: 0, whiteBalance: { tempK: 5000 } } };

  it("moves the profile part-way toward corrections and bumps the version", () => {
    const next = learnFromOverrides(profile, [
      { path: "exposure", value: 1 },
      { path: "whiteBalance.tempK", value: 6000 },
    ]);
    expect(next.baseAdjustments.exposure).toBeCloseTo(0.2);
    expect(next.baseAdjustments.whiteBalance?.tempK).toBeCloseTo(5200);
    expect(next.version).toBe(2);
    expect(profile.baseAdjustments.exposure).toBe(0);
  });

  it("adopts the value directly when the profile had none", () => {
    expect(learnFromOverrides(profile, [{ path: "contrast", value: 20 }]).baseAdjustments.contrast).toBe(20);
  });

  it("is still the same style afterwards: what it was learned from is kept", () => {
    const learned = { ...profile, learnedFrom: "refs-a" };
    const nudged = learnFromOverrides(learned, [{ path: "exposure", value: 1 }]);
    expect(styleLineage(nudged)).toBe(styleLineage(learned));
    expect(StyleProfileSchema.parse(nudged).learnedFrom).toBe("refs-a");
  });
});

describe("a style learned again under the same name", () => {
  const first: StyleProfile = { id: "warm", name: "Warm", version: 1, summary: "warm", baseAdjustments: { exposure: 0.3, whiteBalance: { tempK: 5400 } }, learnedFrom: "refs-a/mock" };

  it("is version 1 when nothing was known before", () => {
    expect(versionAfter(undefined, first).version).toBe(1);
  });

  it("keeps its version when it came out the same, whatever order its settings are written in", () => {
    const again: StyleProfile = { ...first, baseAdjustments: { whiteBalance: { tempK: 5400 }, exposure: 0.3 } };
    expect(versionAfter({ ...first, version: 4 }, again).version).toBe(4);
  });

  it("takes the next version when it came out differently, or was learned from something else", () => {
    expect(versionAfter(first, { ...first, summary: "black and white", baseAdjustments: { saturation: -100 } }).version).toBe(2);
    expect(versionAfter({ ...first, version: 3 }, { ...first, learnedFrom: "refs-a/real-model" }).version).toBe(4);
    const { learnedFrom: _unknown, ...older } = first;
    expect(versionAfter(older, first).version).toBe(2);
  });

  it("is a different style when learned from something else, and the same style at any version otherwise", () => {
    expect(styleLineage({ ...first, version: 7 })).toBe(styleLineage(first));
    expect(styleLineage({ ...first, learnedFrom: "refs-b/mock" })).not.toBe(styleLineage(first));
    expect(styleLineage({ id: "warm" })).toBe("warm");
  });
});

describe("findOutliers", () => {
  it("flags the one recipe that deviates from the album and ignores small albums", () => {
    const album = [0.1, 0.2, 0.1, 0.15, 0.1, 0.2, 0.15, 0.1, 3].map((e, i) => ({ id: `p${i}`, recipe: recipe(e) }));
    expect(findOutliers(album).map((o) => o.id)).toEqual(["p8"]);
    expect(findOutliers(album.slice(0, 4))).toEqual([]);
  });
});

describe("clusterScenes", () => {
  it("separates indoor-warm from outdoor-bright frames", () => {
    const clusters = clusterScenes([
      { id: "in1", meanLuma: 70, tempK: 3200 },
      { id: "out1", meanLuma: 170, tempK: 5600 },
      { id: "in2", meanLuma: 80, tempK: 3400 },
      { id: "out2", meanLuma: 160, tempK: 5400 },
    ]);
    expect(clusters).toEqual([["in1", "in2"], ["out1", "out2"]]);
  });
});
