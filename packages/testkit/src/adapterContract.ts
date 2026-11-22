import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  RecipeAdjustmentsSchema,
  unsupportedFields,
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
  /** An asset of a kind the adapter supports in this environment. */
  asset(): Promise<AssetRef> | AssetRef;
  /** Defaults are photo recipes; adapters for other media kinds supply their own. */
  recipes?: {
    sample: EditRecipe;
    /** A recipe with settings the adapter cannot honor too; defaults to `sample` plus photo-only fields. */
    everything?: EditRecipe;
    /** Set when an empty recipe is meaningless for this adapter and must be refused (ADAPTER_APPLY_FAILED). */
    rejectsEmpty?: boolean;
  };
  /** Needed only when the adapter implements `export`. */
  exportSpec?: ExportSpec;
  /** Extra evidence that an apply really happened (sidecar on disk, message sent to the plugin, …). */
  expectApplied?(asset: AssetRef, outputs: string[]): Promise<void> | void;
}

const photoSample: EditRecipe = {
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

/** Adds settings most adapters cannot honor, to prove unsupported fields never crash an apply. */
const withUnsupportedFields = (r: EditRecipe): EditRecipe => ({
  ...r,
  adjustments: {
    toneCurve: [{ input: 0, output: 0 }, { input: 128, output: 140 }, { input: 255, output: 255 }],
    splitToning: { highlightHue: 40, highlightSaturation: 20, shadowHue: 220, shadowSaturation: 15, balance: 0 },
    crop: { aspectRatio: "4:5", rotationDeg: 1.5 },
    noiseReduction: { luminance: 20, color: 25 },
    sharpening: { amount: 40, radius: 1 },
    lutRef: "warm.cube",
    ...r.adjustments,
  },
});

const knownFields = Object.keys(RecipeAdjustmentsSchema.shape);

/**
 * The behaviour every editor adapter must show, whatever tool is behind it (plan §7.5). Register it from an
 * adapter's own test file: `adapterContract({ name, create, asset })`.
 */
export function adapterContract(opts: AdapterContractOptions): void {
  const sample = opts.recipes?.sample ?? photoSample;
  const everything = opts.recipes?.everything ?? withUnsupportedFields(sample);

  describe(`adapter contract: ${opts.name}`, () => {
    let subject: AdapterUnderTest;
    let asset: AssetRef;

    const ready = async () => {
      subject ??= await opts.create();
      asset ??= await opts.asset();
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

    it("applies a recipe to an asset and reports what it touched", async () => {
      const { adapter, asset } = await ready();
      const result = await adapter.applyRecipe(asset, sample);
      expect(result.assetId).toBe(asset.id);
      expect(Array.isArray(result.outputs)).toBe(true);
      expect(result.outputs.every((o) => typeof o === "string")).toBe(true);
      await opts.expectApplied?.(asset, result.outputs);
    });

    it("handles an empty recipe and one using fields it does not support without crashing", async () => {
      const { adapter, asset } = await ready();
      const empty: EditRecipe = { version: "1.0", assetType: sample.assetType, adjustments: {} };
      if (opts.recipes?.rejectsEmpty) {
        await expect(adapter.applyRecipe(asset, empty)).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED" });
      } else {
        await expect(adapter.applyRecipe(asset, empty)).resolves.toMatchObject({ assetId: asset.id });
      }
      await expect(adapter.applyRecipe(asset, everything)).resolves.toMatchObject({ assetId: asset.id });
    });

    it("is repeatable: applying the same recipe twice gives the same outputs", async () => {
      const { adapter, asset } = await ready();
      const first = await adapter.applyRecipe(asset, sample);
      const second = await adapter.applyRecipe(asset, sample);
      expect(second.outputs).toEqual(first.outputs);
    });

    it("does not start work for a job that was already cancelled", async () => {
      const { adapter, asset } = await ready();
      const controller = new AbortController();
      controller.abort();
      await expect(adapter.applyRecipe(asset, sample, { jobId: "cancelled-job", signal: controller.signal })).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });
    });

    it("reports what it replaced so an apply can be undone, and only claims backups that exist", async () => {
      const { adapter, asset } = await ready();
      await adapter.applyRecipe(asset, sample, { jobId: "undo-check" });
      const result = await adapter.applyRecipe(asset, { ...sample, adjustments: { ...sample.adjustments, exposure: -0.2 } }, { jobId: "undo-check" });
      for (const r of result.replaced ?? []) {
        expect(result.outputs).toContain(r.target);
        if (r.backup) expect(existsSync(r.backup), `backup ${r.backup} is claimed but missing`).toBe(true);
      }
    });

    it("accounts for every asset it is asked to import, never silently dropping one", async () => {
      const { adapter, asset } = await ready();
      if (!adapter.importAssets) return;
      const missing: AssetRef = { id: "never-existed", kind: asset.kind, path: path.join(path.dirname(asset.path), "never-existed.cr3") };
      const result = await adapter.importAssets([asset, missing], { jobId: "import-check" });
      expect([...result.imported, ...result.skipped.map((s) => s.assetId)].sort()).toEqual([asset.id, missing.id].sort());
      for (const skipped of result.skipped) expect(skipped.reason.length, `no reason given for ${skipped.assetId}`).toBeGreaterThan(0);
    });

    it("is safe to cancel when nothing is running, and keeps working afterwards", async () => {
      const { adapter, asset } = await ready();
      if (!adapter.cancel) return;
      await expect(adapter.cancel("nothing-running")).resolves.toBeUndefined();
      await expect(adapter.applyRecipe(asset, sample, { jobId: "nothing-running" })).resolves.toMatchObject({ assetId: asset.id });
    });

    it("shows what a recipe turns into without applying it, and agrees with the fields it declares", async () => {
      const { adapter, asset } = await ready();
      if (!adapter.translateRecipe) return;
      const native = adapter.translateRecipe(everything, asset);
      expect(native.kind).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(native.payload).toBeTruthy();
      expect([...native.unsupported].sort()).toEqual([...unsupportedFields(everything, adapter.capabilities.supportedRecipeFields)].sort());
      expect(adapter.translateRecipe(everything, asset)).toEqual(native);
    });

    it("offers progress as something a consumer can stop listening to", async () => {
      const { adapter } = await ready();
      if (!adapter.getProgress) return;
      const iterator = adapter.getProgress("progress-check")[Symbol.asyncIterator]();
      await expect(iterator.return?.() ?? Promise.resolve()).resolves.toBeDefined();
    });

    it("refuses media kinds it does not support with a stable error code", async () => {
      const { adapter } = await ready();
      const unsupported = (["photo", "video"] as const).find((k) => !adapter.capabilities.mediaKinds.includes(k));
      if (!unsupported) return;
      const foreign: AssetRef = { id: "other", kind: unsupported, path: unsupported === "video" ? "clip.mov" : "shot.cr3" };
      await expect(adapter.applyRecipe(foreign, { ...sample, assetType: unsupported })).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED" });
    });

    it.skipIf(!opts.exportSpec)("exports when it claims to", async () => {
      const { adapter, asset } = await ready();
      if (!adapter.export) return;
      const out = await adapter.export(asset, opts.exportSpec!);
      expect(out.assetId).toBe(asset.id);
      expect(typeof out.file).toBe("string");
    });

    it.skipIf(!opts.exportSpec)("writes the file name it is given, so two photos with one name can never share an output file", async () => {
      const { adapter, asset } = await ready();
      if (!adapter.export) return;
      const first = await adapter.export(asset, { ...opts.exportSpec!, fileName: "IMG_001" });
      const second = await adapter.export(asset, { ...opts.exportSpec!, fileName: "IMG_001-jpg" });
      expect(path.parse(first.file).name).toBe("IMG_001");
      expect(path.parse(second.file).name).toBe("IMG_001-jpg");
      expect(second.file).not.toBe(first.file);
      expect(path.dirname(second.file)).toBe(path.dirname(first.file));
      // A name can never steer the output out of its folder.
      const sneaky = await adapter.export(asset, { ...opts.exportSpec!, fileName: path.join("..", "escaped") });
      expect(path.dirname(sneaky.file)).toBe(path.dirname(first.file));
    });
  });
}
