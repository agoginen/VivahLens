import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EditRecipe } from "@vivahlens/core";
import { buildXmp, compileToCrsSettings, mergeXmp } from "./compile.js";
import { XmpSidecarAdapter } from "./xmpSidecarAdapter.js";

const recipe: EditRecipe = {
  version: "1.0",
  assetType: "photo",
  adjustments: {
    exposure: 0.35,
    contrast: -12.4,
    whiteBalance: { tempK: 5200.6, tint: 4 },
    hsl: { orange: { hue: 5, luminance: -8 } },
    sharpening: { amount: 40, radius: 1 },
  },
};

describe("compileToCrsSettings", () => {
  it("maps recipe fields to signed Camera Raw values", () => {
    expect(compileToCrsSettings(recipe)).toMatchObject({
      Exposure2012: "+0.35",
      Contrast2012: "-12",
      WhiteBalance: "Custom",
      Temperature: "5201",
      Tint: "+4",
      HueAdjustmentOrange: "+5",
      LuminanceAdjustmentOrange: "-8",
      Sharpness: "40",
      SharpenRadius: "+1.0",
    });
  });
});

describe("mergeXmp", () => {
  const existing = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="4" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+1.00"/></rdf:RDF></x:xmpmeta>`;

  it("updates existing settings and keeps unrelated metadata", () => {
    const merged = mergeXmp(existing, { Exposure2012: "+0.35", Contrast2012: "-12" });
    expect(merged).toContain('xmp:Rating="4"');
    expect(merged).toContain('crs:Exposure2012="+0.35"');
    expect(merged).not.toContain('crs:Exposure2012="+1.00"');
    expect(merged).toContain('crs:Contrast2012="-12"');
  });

  it("adds the crs namespace when a sidecar lacks it", () => {
    const bare = existing.replace(/ xmlns:crs="[^"]*"/, "").replace(/ crs:Exposure2012="[^"]*"/, "");
    expect(mergeXmp(bare, { Exposure2012: "+1.00" })).toContain("xmlns:crs=");
  });
});

describe("XmpSidecarAdapter", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vivah-xmp-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a new sidecar, then merges into it on re-apply", async () => {
    const adapter = new XmpSidecarAdapter();
    const asset = { id: "a", kind: "photo" as const, path: path.join(dir, "IMG_1.CR3") };
    const { outputs } = await adapter.applyRecipe(asset, recipe);
    expect(readFileSync(outputs[0]!, "utf8")).toContain('crs:Exposure2012="+0.35"');

    writeFileSync(outputs[0]!, readFileSync(outputs[0]!, "utf8").replace("<rdf:Description", '<rdf:Description xmp:Rating="5"'));
    await adapter.applyRecipe(asset, { ...recipe, adjustments: { exposure: -1 } });
    const text = readFileSync(outputs[0]!, "utf8");
    expect(text).toContain('xmp:Rating="5"');
    expect(text).toContain('crs:Exposure2012="-1.00"');
  });

  it("rejects video assets", async () => {
    await expect(new XmpSidecarAdapter().applyRecipe({ id: "v", kind: "video", path: "x.mov" }, recipe)).rejects.toMatchObject({
      code: "ADAPTER_APPLY_FAILED",
    });
  });

  it("buildXmp output is well-formed enough to merge", () => {
    expect(() => mergeXmp(buildXmp({ Version: "15.0" }), { Exposure2012: "+1.00" })).not.toThrow();
  });
});
