import { describe, expect, it } from "vitest";
import type { AssetRef, EditRecipe } from "@vivahlens/core";
import type { Rgba } from "@vivahlens/ingest";
import { scorePerceptually, type PerceptualCase } from "./perceptualEval.js";

/** A picture with some range in it, so that an edit has something to change. */
function picture(width = 96, height = 64): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = 70 + 110 * (x / width) * (0.5 + 0.5 * Math.sin((y / height) * 6));
      data.set([v, v * 0.9 + 12, v * 0.75 + 20, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const recipe = (adjustments: EditRecipe["adjustments"]): EditRecipe => ({ version: "1.0", assetType: "photo", adjustments });
const asset = (id: string): AssetRef => ({ id, kind: "photo", path: `/photos/${id}.jpg` });
const load = async () => picture();
const kase = (id: string, expected: EditRecipe, actual: unknown): PerceptualCase => ({ id, asset: asset(id), expected, actual });

describe("scorePerceptually", () => {
  it("finds no difference between a recipe and itself", async () => {
    const r = recipe({ exposure: 0.4, contrast: 10 });
    const { scores, skipped } = await scorePerceptually([kase("a", r, r)], { load });
    expect(skipped).toBe(0);
    expect(scores[0]).toMatchObject({ id: "a", deltaE: { mean: 0, p95: 0 } });
    expect(scores[0]!.ssim).toBeCloseTo(1, 9);
  });

  it("finds a larger difference the further the exposure is from the photographer's", async () => {
    const truth = recipe({ exposure: 0 });
    const { scores } = await scorePerceptually([0.2, 0.5, 1.5].map((ev) => kase(String(ev), truth, recipe({ exposure: ev }))), { load });
    const means = scores.map((s) => s.deltaE.mean);
    expect(means[0]!).toBeGreaterThan(0);
    expect(means[1]!).toBeGreaterThan(means[0]!);
    expect(means[2]!).toBeGreaterThan(means[1]!);
    expect(scores.map((s) => s.ssim)).toEqual([...scores.map((s) => s.ssim)].sort((a, b) => b - a));
  });

  it("scores framing as no difference, since it is composition and not the look", async () => {
    const framed = recipe({ exposure: 0.3, crop: { x: 0.2, y: 0.1, width: 0.5, height: 0.6, rotationDeg: 3 } });
    const plain = recipe({ exposure: 0.3 });
    const { scores } = await scorePerceptually([kase("c", framed, plain), kase("d", plain, framed)], { load });
    expect(scores.map((s) => s.deltaE.mean)).toEqual([0, 0]);
  });

  it("leaves out a proposal that is not a recipe and a picture that cannot be read, and says how many", async () => {
    const truth = recipe({ exposure: 0.2 });
    const unreadable = async (a: AssetRef) => {
      if (a.id === "gone") throw new Error("no such file");
      return picture();
    };
    const { scores, skipped } = await scorePerceptually(
      [kase("ok", truth, recipe({ exposure: 0.4 })), kase("junk", truth, { exposure: "lots" }), kase("missing", truth, undefined), kase("gone", truth, recipe({ exposure: 0.4 }))],
      { load: unreadable },
    );
    expect(scores.map((s) => s.id)).toEqual(["ok"]);
    expect(skipped).toBe(3);
  });

  it("stops when cancelled", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(scorePerceptually([kase("a", recipe({}), recipe({}))], { load, signal: abort.signal })).rejects.toThrow();
  });
});
