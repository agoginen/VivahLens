import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EditRecipe } from "@vivahlens/core";
import { BASIC_FIELDS, buildXmp, compileToCrs, isGeneratedByVivah, compileToCrsSettings, mergeXmp } from "./compile.js";
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

  it("builds sidecars that are marked as written by VivahLens, and merging marks existing ones too", () => {
    expect(isGeneratedByVivah(buildXmp({ Version: "15.0" }))).toBe(true);
    const photographers = `<rdf:Description xmlns:crs="x" crs:HasSettings="True" crs:Exposure2012="+1.00"/>`;
    expect(isGeneratedByVivah(photographers)).toBe(false);
    expect(isGeneratedByVivah(mergeXmp(photographers, { Exposure2012: "+0.50" }))).toBe(true);
  });

  it("buildXmp output is well-formed enough to merge", () => {
    expect(() => mergeXmp(buildXmp({ Version: "15.0" }), { Exposure2012: "+1.00" })).not.toThrow();
  });
});

describe("extended develop settings", () => {
  const wellFormed = (xml: string): boolean => {
    const stack: string[] = [];
    for (const m of xml.matchAll(/<(\/)?([A-Za-z][\w:.-]*)\b[^>]*?(\/)?>/g)) {
      if (m[3]) continue;
      if (m[1]) {
        if (stack.pop() !== m[2]) return false;
      } else stack.push(m[2]!);
    }
    return stack.length === 0;
  };
  const recipeOf = (adjustments: EditRecipe["adjustments"]): EditRecipe => ({ version: "1.0", assetType: "photo", adjustments });

  it("writes clarity, texture, dehaze, vignette and grain under the names Lightroom reads", () => {
    const out = compileToCrs(recipeOf({ clarity: 12, texture: -8, dehaze: 15, vignette: { amount: -20, midpoint: 40, feather: 60, roundness: 5 }, grain: { amount: 18, size: 25, roughness: 50 } }));
    expect(out.attributes).toMatchObject({
      Clarity2012: "+12",
      Texture: "-8",
      Dehaze: "+15",
      PostCropVignetteAmount: "-20",
      PostCropVignetteMidpoint: "40",
      PostCropVignetteFeather: "60",
      PostCropVignetteRoundness: "+5",
      PostCropVignetteStyle: "1",
      GrainAmount: "18",
      GrainSize: "25",
      GrainFrequency: "50",
    });
    expect(out.warnings).toEqual([]);
  });

  it("writes the tone curve as a list element from corner to corner, sorted and rounded, and says when it cannot", () => {
    const curve = compileToCrs(recipeOf({ toneCurve: [{ input: 192.4, output: 200 }, { input: 64, output: 56.6 }] }));
    expect(curve.sequences.ToneCurvePV2012).toEqual(["0, 0", "64, 57", "192, 200", "255, 255"]);
    expect(curve.attributes.ToneCurveName2012).toBe("Custom");

    for (const flat of [[{ input: 0, output: 0 }, { input: 255, output: 255 }], [{ input: 128, output: 128 }], []]) {
      const r = compileToCrs(recipeOf({ toneCurve: flat }));
      expect(r.sequences.ToneCurvePV2012).toBeUndefined();
      expect(r.attributes.ToneCurveName2012).toBeUndefined();
    }
    expect(compileToCrs(recipeOf({ toneCurve: [{ input: 128, output: 128 }] })).warnings[0]).toMatch(/tone curve/);
  });

  it("writes a crop as the rectangle Lightroom stores, and explains a crop it cannot express", () => {
    const ok = compileToCrs(recipeOf({ crop: { x: 0.05, y: 0.1, width: 0.8, height: 0.7, rotationDeg: 1.5 } }));
    expect(ok.attributes).toMatchObject({ HasCrop: "True", CropLeft: "0.05", CropTop: "0.1", CropRight: "0.85", CropBottom: "0.8", CropAngle: "1.5", CropConstrainToWarp: "0" });
    expect(ok.warnings).toEqual([expect.stringContaining("direction of the crop angle")]);

    const aspectOnly = compileToCrs(recipeOf({ crop: { aspectRatio: "4:5", rotationDeg: 1 } }));
    expect(aspectOnly.attributes.HasCrop).toBeUndefined();
    expect(aspectOnly.warnings).toEqual([expect.stringContaining("needs a rectangle")]);

    const outside = compileToCrs(recipeOf({ crop: { x: 1.2, y: 0, width: 0.5, height: 1 } }));
    expect(outside.attributes.HasCrop).toBeUndefined();
    expect(outside.warnings).toEqual([expect.stringContaining("outside the photo")]);
    // A rectangle that runs past the edge is clipped to it.
    expect(compileToCrs(recipeOf({ crop: { x: 0.5, y: 0, width: 0.9, height: 1 } })).attributes.CropRight).toBe("1");
  });

  it("can be limited to the fields a consumer is known to understand", () => {
    const r = recipeOf({ exposure: 0.5, clarity: 10, toneCurve: [{ input: 64, output: 50 }, { input: 192, output: 200 }] });
    const basic = compileToCrs(r, BASIC_FIELDS);
    expect(basic.attributes.Exposure2012).toBe("+0.50");
    expect(basic.attributes.Clarity2012).toBeUndefined();
    expect(basic.sequences).toEqual({});
    expect(compileToCrsSettings(r, BASIC_FIELDS)).toEqual(basic.attributes);
  });

  it("builds a sidecar with the curve inside the description, still well formed", () => {
    const xmp = buildXmp({ Version: "15.0", Exposure2012: "+0.50" }, { ToneCurvePV2012: ["0, 0", "128, 140", "255, 255"] });
    expect(wellFormed(xmp)).toBe(true);
    expect(xmp).toContain("<crs:ToneCurvePV2012>");
    expect(xmp.match(/<rdf:li>/g)).toHaveLength(3);
    expect(wellFormed(buildXmp({ Version: "15.0" }))).toBe(true);
  });

  it("replaces a photographer's own curve and keeps their other metadata, without growing when applied again", () => {
    const own = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
 <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="4" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+1.00">
  <crs:ToneCurvePV2012>
   <rdf:Seq>
    <rdf:li>0, 0</rdf:li>
    <rdf:li>100, 90</rdf:li>
    <rdf:li>255, 255</rdf:li>
   </rdf:Seq>
  </crs:ToneCurvePV2012>
  <dc:subject xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Bag><rdf:li>wedding</rdf:li></rdf:Bag></dc:subject>
 </rdf:Description>
</rdf:RDF></x:xmpmeta>`;
    const curve = { ToneCurvePV2012: ["0, 0", "64, 57", "192, 200", "255, 255"] };

    const once = mergeXmp(own, { Exposure2012: "+0.35" }, curve);
    expect(wellFormed(once)).toBe(true);
    expect(once).toContain('xmp:Rating="4"');
    expect(once).toContain("<rdf:li>wedding</rdf:li>");
    expect(once).toContain("<rdf:li>64, 57</rdf:li>");
    expect(once).not.toContain("<rdf:li>100, 90</rdf:li>");
    expect(once.match(/<crs:ToneCurvePV2012>/g)).toHaveLength(1);

    const twice = mergeXmp(once, { Exposure2012: "+0.35" }, curve);
    expect(twice).toBe(once);
  });

  it("opens a self-closing description to hold the curve", () => {
    const bare = `<x:xmpmeta><rdf:RDF><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="2"/></rdf:RDF></x:xmpmeta>`;
    const merged = mergeXmp(bare, { Exposure2012: "+1.00" }, { ToneCurvePV2012: ["0, 0", "128, 150", "255, 255"] });
    expect(wellFormed(merged)).toBe(true);
    expect(merged).toContain('xmp:Rating="2"');
    expect(merged).toContain('crs:Exposure2012="+1.00"');
    expect(merged).toContain("<rdf:li>128, 150</rdf:li>");
  });
});

describe("XmpSidecarAdapter and where settings live", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vivah-xmp-formats-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("warns that Lightroom ignores a sidecar for a JPEG or TIFF, because it keeps those settings in the file, and stays quiet for a raw file", async () => {
    const adapter = new XmpSidecarAdapter();
    for (const name of ["a.jpg", "b.TIFF", "c.png"]) {
      const result = await adapter.applyRecipe({ id: name, kind: "photo", path: path.join(dir, name) }, recipe);
      expect(result.warnings?.[0], name).toMatch(/inside the file and ignore a sidecar/);
    }
    for (const name of ["d.CR3", "e.NEF", "f.dng"]) {
      const result = await adapter.applyRecipe({ id: name, kind: "photo", path: path.join(dir, name) }, recipe);
      expect(result.warnings, name).toBeUndefined();
    }
  });

  it("writes the extended settings into the sidecar and passes along what it could not write", async () => {
    const adapter = new XmpSidecarAdapter();
    const asset = { id: "x", kind: "photo" as const, path: path.join(dir, "x.CR3") };
    const result = await adapter.applyRecipe(asset, {
      version: "1.0",
      assetType: "photo",
      adjustments: { clarity: 10, toneCurve: [{ input: 64, output: 50 }, { input: 192, output: 205 }], crop: { aspectRatio: "4:5" } },
    });
    const text = readFileSync(result.outputs[0]!, "utf8");
    expect(text).toContain('crs:Clarity2012="+10"');
    expect(text).toContain("<rdf:li>64, 50</rdf:li>");
    expect(result.warnings).toEqual([expect.stringContaining("needs a rectangle")]);
  });
});

describe("XmpSidecarAdapter and a photographer's own sidecars", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vivah-xmp-own-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const own = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="4"/></rdf:RDF></x:xmpmeta>`;

  it("keeps a copy of an existing sidecar before merging into it, and reports it so the apply can be undone", async () => {
    const asset = { id: "a", kind: "photo" as const, path: path.join(dir, "IMG_1.CR3") };
    const sidecar = path.join(dir, "IMG_1.xmp");
    writeFileSync(sidecar, own);

    const result = await new XmpSidecarAdapter({ backupDir: path.join(dir, "backups") }).applyRecipe(asset, recipe, { jobId: "job-7" });

    expect(readFileSync(sidecar, "utf8")).toContain('xmp:Rating="4"');
    expect(readFileSync(sidecar, "utf8")).toContain('crs:Exposure2012="+0.35"');
    expect(result.replaced).toHaveLength(1);
    expect(result.replaced![0]!.backup).toContain(path.join("backups", "job-7"));
    expect(readFileSync(result.replaced![0]!.backup!, "utf8")).toBe(own);
    expect(result.warnings).toBeUndefined();
  });

  it("still merges without a backup folder, but says it cannot be undone and offers nothing that would delete the photographer's file", async () => {
    const asset = { id: "b", kind: "photo" as const, path: path.join(dir, "IMG_2.CR3") };
    writeFileSync(path.join(dir, "IMG_2.xmp"), own);

    const result = await new XmpSidecarAdapter().applyRecipe(asset, recipe);

    expect(result.replaced).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining("cannot be undone")]);
    expect(readFileSync(path.join(dir, "IMG_2.xmp"), "utf8")).toContain('crs:Exposure2012="+0.35"');
  });

  it("reports a sidecar it created as new, so that undoing removes it", async () => {
    const asset = { id: "c", kind: "photo" as const, path: path.join(dir, "IMG_3.CR3") };
    const result = await new XmpSidecarAdapter({ backupDir: path.join(dir, "backups") }).applyRecipe(asset, recipe, { jobId: "job-8" });
    expect(result.replaced).toEqual([{ target: path.join(dir, "IMG_3.xmp"), writtenSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  });

  it("finds files that are missing before a sidecar is written for them", async () => {
    writeFileSync(path.join(dir, "real.CR3"), "raw");
    const result = await new XmpSidecarAdapter().importAssets([
      { id: "real", kind: "photo", path: path.join(dir, "real.CR3") },
      { id: "gone", kind: "photo", path: path.join(dir, "gone.CR3") },
    ]);
    expect(result.imported).toEqual(["real"]);
    expect(result.skipped).toEqual([{ assetId: "gone", reason: "gone.CR3 does not exist or cannot be read" }]);
  });

  it("shows the sidecar a recipe would produce without writing anything, naming what it ignores", () => {
    const native = new XmpSidecarAdapter().translateRecipe({ ...recipe, adjustments: { ...recipe.adjustments, lutRef: "warm.cube" } });
    expect(native.kind).toBe("xmp");
    expect(native.payload).toContain('crs:Exposure2012="+0.35"');
    expect(native.unsupported).toEqual(["lutRef"]);
  });
});
