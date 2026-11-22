import { describe, expect, it } from "vitest";
import { EXPORT_PRESET_NAMES, EXPORT_PRESETS, resolveExportSpec } from "./presets.js";

describe("resolveExportSpec", () => {
  it("expands a preset into a spec for the output folder", () => {
    expect(resolveExportSpec({ preset: "web", outputDir: "/out" })).toEqual({ format: "jpeg", maxEdgePx: 2048, quality: 85, outputDir: "/out" });
    // Print is full resolution: no size at all, not an undefined one.
    expect(resolveExportSpec({ preset: "print", outputDir: "/out" })).toEqual({ format: "jpeg", quality: 95, outputDir: "/out" });
    for (const name of EXPORT_PRESET_NAMES) expect(resolveExportSpec({ preset: name, outputDir: "/o" }).quality).toBe(EXPORT_PRESETS[name].quality);
  });

  it("lets explicit choices override the preset, and works without one", () => {
    expect(resolveExportSpec({ preset: "web", maxEdgePx: 1600, quality: 70, outputDir: "/o" })).toMatchObject({ maxEdgePx: 1600, quality: 70 });
    expect(resolveExportSpec({ outputDir: "/o" })).toEqual({ format: "jpeg", outputDir: "/o" });
    expect(resolveExportSpec({ format: "tiff", outputDir: "/o" })).toEqual({ format: "tiff", outputDir: "/o" });
  });

  it("rejects values that would produce a useless or dangerous export, in words the user can act on", () => {
    expect(() => resolveExportSpec({ preset: "nope", outputDir: "/o" })).toThrow(/Unknown preset "nope".*web, social, album, print/);
    // Names that exist on every object must not count as presets.
    expect(() => resolveExportSpec({ preset: "constructor", outputDir: "/o" })).toThrow(/Unknown preset/);
    expect(() => resolveExportSpec({ preset: "toString", outputDir: "/o" })).toThrow(/Unknown preset/);
    expect(() => resolveExportSpec({ format: "png", outputDir: "/o" })).toThrow(/Unknown format/);
    for (const quality of [0, 101, 85.5, Number.NaN]) expect(() => resolveExportSpec({ quality, outputDir: "/o" })).toThrow(/Quality/);
    for (const maxEdgePx of [0, 99, 30_001, 2048.5, Number.NaN]) expect(() => resolveExportSpec({ maxEdgePx, outputDir: "/o" })).toThrow(/Maximum edge/);
  });
});
