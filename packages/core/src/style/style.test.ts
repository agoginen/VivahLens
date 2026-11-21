import { describe, expect, it } from "vitest";
import type { EditRecipe } from "../recipe/editRecipe.js";
import { findOutliers } from "./consistency.js";
import { clusterScenes } from "./sceneCluster.js";
import { learnFromOverrides, type StyleProfile } from "./styleProfile.js";

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
