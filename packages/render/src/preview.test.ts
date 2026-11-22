import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import type { AssetRef, EditRecipe } from "@vivahlens/core";
import type { Rgba } from "./color.js";
import { createPreviewRenderer } from "./preview.js";

const asset = (id: string): AssetRef => ({ id, kind: "photo", path: `/shoot/${id}` });
const grey = (): Rgba => ({ width: 16, height: 8, data: new Uint8Array(16 * 8 * 4).fill(119).map((v, i) => (i % 4 === 3 ? 255 : v)) });
const recipe = (exposure: number): EditRecipe => ({ version: "1.0", assetType: "photo", adjustments: { exposure } });
const centreOf = (preview: { dataBase64: string }) => {
  const image = jpeg.decode(Buffer.from(preview.dataBase64, "base64"), { useTArray: true, formatAsRGBA: true });
  return image.data[((image.height >> 1) * image.width + (image.width >> 1)) * 4]!;
};

describe("createPreviewRenderer", () => {
  it("draws the recipe onto the picture and returns a JPEG", async () => {
    const render = createPreviewRenderer({ load: async () => grey() });
    const plain = await render(asset("a"), recipe(0));
    const brighter = await render(asset("a"), recipe(1));
    expect(plain.mediaType).toBe("image/jpeg");
    expect(Math.abs(centreOf(plain) - 119)).toBeLessThanOrEqual(3);
    expect(centreOf(brighter)).toBeGreaterThan(centreOf(plain) + 30);
  });

  it("decodes each picture once while it is in the cache, forgets the oldest beyond the limit, and does not remember failures", async () => {
    const loads: string[] = [];
    let failing = true;
    const render = createPreviewRenderer({
      cacheSize: 2,
      load: async (a) => {
        loads.push(a.id);
        if (a.id === "bad" && failing) throw new Error("unreadable");
        return grey();
      },
    });
    await render(asset("a"), recipe(0));
    await render(asset("a"), recipe(0.5));
    expect(loads).toEqual(["a"]);

    await render(asset("b"), recipe(0));
    await render(asset("a"), recipe(0)); // a is now the most recently used
    await render(asset("c"), recipe(0)); // pushes out b, the oldest
    await render(asset("a"), recipe(0));
    expect(loads).toEqual(["a", "b", "c"]);
    await render(asset("b"), recipe(0));
    expect(loads).toEqual(["a", "b", "c", "b"]);

    await expect(render(asset("bad"), recipe(0))).rejects.toThrow("unreadable");
    failing = false;
    await expect(render(asset("bad"), recipe(0))).resolves.toMatchObject({ mediaType: "image/jpeg" });
  });
});
