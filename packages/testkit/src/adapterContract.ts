import { afterAll, describe, expect, it } from "vitest";
import {
  RecipeAdjustmentsSchema,
  type AssetRef,
  type EditorAdapter,
  type EditRecipe,
  type ExportSpec,
} from "@vivahlens/core";

export interface AdapterUnderTest {
  adapter: EditorAdapter;
  cleanup?(): Promise<void> | void;
}

export interface AdapterContractOptions {
  /** Shown in the test title. */
  name: string;
  /** Builds a fresh adapter wired to fakes or temp dirs; called once per suite. */
  create(): Promise<AdapterUnderTest> | AdapterUnderTest;
  /** A photo the adapter can act on in this environment. */
  photo(): Promise<AssetRef> | AssetRef;
  /** Needed only when the adapter implements `export`. */
  exportSpec?: ExportSpec;
  /** Extra evidence that an apply really happened (sidecar on disk, message sent to the plugin, …). */
  expectApplied?(asset: AssetRef, outputs: string[]): Promise<void> | void;
}

const sample: EditRecipe = {
  version: "1.0",
  assetType: "photo",
  adjustments: {
    exposure: 0.35,
    contrast: -8,
    highlights: -30,
    shadows: 20,
    vibrance: 10,
    whiteBalance: { tempK: 5200, tint: 3 },
    hsl: { orange: { hue: 4, luminance: -6 } },
  },
};

/** Every adjustment, including ones most adapters cannot honor, to prove unsupported fields never crash an apply. */
const everything: EditRecipe = {
  ...sample,
  adjustments: {
    ...sample.adjustments,
    toneCurve: [{ input: 0, output: 0 }, { input: 128, output: 140 }, { input: 255, output: 255 }],
    splitToning: { highlightHue: 40, highlightSaturation: 20, shadowHue: 220, shadowSaturation: 15, balance: 0 },
    crop: { aspectRatio: "4:5", rotationDeg: 1.5 },
    noiseReduction: { luminance: 20, color: 25 },
    sharpening: { amount: 40, radius: 1 },
    lutRef: "warm.cube",
  },
};

const knownFields = Object.keys(RecipeAdjustmentsSchema.shape);

/**
 * The behaviour every editor adapter must show, whatever tool is behind it (plan §7.5). Register it from an
 * adapter's own test file: `adapterContract({ name, create, photo })`.
 */
export function adapterContract(opts: AdapterContractOptions): void {
  describe(`adapter contract: ${opts.name}`, () => {
    let subject: AdapterUnderTest;
    let asset: AssetRef;

    const ready = async () => {
      subject ??= await opts.create();
      asset ??= await opts.photo();
      return { adapter: subject.adapter, asset };
    };
    afterAll(async () => subject?.cleanup?.());

    it("identifies itself and declares honest capabilities", async () => {
      const { adapter } = await ready();
      expect(adapter.id).toMatch(/^[a-z][a-z0-9-]*$/);
      const caps = adapter.capabilities;
      expect(caps.mediaKinds.length).toBeGreaterThan(0);
      expect(caps.os.length).toBeGreaterThan(0);
      expect(caps.supportedRecipeFields.length).toBeGreaterThan(0);
      for (const f of caps.supportedRecipeFields) expect(knownFields, `unknown recipe field "${f}"`).toContain(f);
      expect(["local-plugin", "local-cli", "cloud-headless"]).toContain(caps.executionModel);
    });

    it("detects without throwing, returning an info object or null", async () => {
      const { adapter } = await ready();
      const info = await adapter.detect();
      expect(info === null || typeof info === "object").toBe(true);
    });

    it("applies a recipe to a photo and reports what it touched", async () => {
      const { adapter, asset } = await ready();
      const result = await adapter.applyRecipe(asset, sample);
      expect(result.assetId).toBe(asset.id);
      expect(Array.isArray(result.outputs)).toBe(true);
      expect(result.outputs.every((o) => typeof o === "string")).toBe(true);
      await opts.expectApplied?.(asset, result.outputs);
    });

    it("applies an empty recipe and one using fields it does not support without crashing", async () => {
      const { adapter, asset } = await ready();
      await expect(adapter.applyRecipe(asset, { version: "1.0", assetType: "photo", adjustments: {} })).resolves.toMatchObject({ assetId: asset.id });
      await expect(adapter.applyRecipe(asset, everything)).resolves.toMatchObject({ assetId: asset.id });
    });

    it("is repeatable: applying the same recipe twice gives the same outputs", async () => {
      const { adapter, asset } = await ready();
      const first = await adapter.applyRecipe(asset, sample);
      const second = await adapter.applyRecipe(asset, sample);
      expect(second.outputs).toEqual(first.outputs);
    });

    it("refuses media kinds it does not support with a stable error code", async () => {
      const { adapter } = await ready();
      if (adapter.capabilities.mediaKinds.includes("video")) return;
      await expect(adapter.applyRecipe({ id: "clip", kind: "video", path: "clip.mov" }, { ...sample, assetType: "video" })).rejects.toMatchObject({
        code: "ADAPTER_APPLY_FAILED",
      });
    });

    it.skipIf(!opts.exportSpec)("exports when it claims to", async () => {
      const { adapter, asset } = await ready();
      if (!adapter.export) return;
      const out = await adapter.export(asset, opts.exportSpec!);
      expect(out.assetId).toBe(asset.id);
      expect(typeof out.file).toBe("string");
    });
  });
}
