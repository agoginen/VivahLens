import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AssetRef, EditorAdapter, ExportSpec } from "../adapters/editorAdapter.js";
import type { GrayImage } from "../culling/metrics.js";
import { VivahError } from "../errors.js";
import { LlmGateway } from "../llm/gateway.js";
import type { LlmProvider } from "../llm/types.js";
import type { EditRecipe } from "../recipe/editRecipe.js";
import type { StyleProfile } from "../style/styleProfile.js";
import { MemoryStore } from "./libraryStore.js";
import { exportApproved, runJob, type PipelineDeps } from "./runJob.js";
import { SqliteStore } from "./sqliteStore.js";

const profile: StyleProfile = { id: "warm", name: "Warm", version: 1, summary: "warm and airy", baseAdjustments: { exposure: 0.3 } };

/** Replies with a recipe for the photo whose id is carried in the image payload; can be told to reject some. */
function fakeLlm(denied = new Set<string>()) {
  const calls: string[] = [];
  const provider: LlmProvider = {
    id: "fake",
    async complete(req) {
      const parts = req.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
      const id = parts.find((p) => p.type === "image")?.type === "image" ? (parts.find((p) => p.type === "image") as { dataBase64: string }).dataBase64 : "?";
      calls.push(id);
      if (denied.has(id)) throw new VivahError("LLM_AUTH", "denied");
      return { text: JSON.stringify({ adjustments: { exposure: 0.5, contrast: 10 }, confidence: 0.9 }) };
    },
  };
  const gateway = new LlmGateway().registerProvider(provider).setRoute("vision", { providerId: "fake", model: "m" });
  return { gateway, calls, denied };
}

function fakeAdapter(failApply = new Set<string>(), opts: { exportResize?: boolean } = {}) {
  const applied: { id: string; recipe: EditRecipe }[] = [];
  const exportSpecs: ExportSpec[] = [];
  const adapter: EditorAdapter = {
    id: "fake-editor",
    capabilities: { mediaKinds: ["photo"], executionModel: "local-cli", requiresGuiOpen: false, os: ["windows", "macos"], supportedRecipeFields: ["exposure"], exportResize: opts.exportResize },
    detect: async () => ({}),
    async applyRecipe(asset, recipe) {
      if (failApply.has(asset.id)) throw new VivahError("ADAPTER_APPLY_FAILED", "boom");
      applied.push({ id: asset.id, recipe });
      return { assetId: asset.id, outputs: [`${asset.path}.sidecar`] };
    },
    async export(asset, spec) {
      exportSpecs.push(spec);
      return { assetId: asset.id, file: path.join(spec.outputDir, `${spec.fileName ?? asset.id}.jpg`) };
    },
  };
  return { adapter, applied, exportSpecs };
}

const asset = (id: string): AssetRef => ({ id, kind: "photo", path: `/shoot/${id}.cr3` });
const noise = (seed: number, reverse = false): GrayImage => {
  const data = new Uint8Array(64 * 64);
  let s = seed;
  for (let i = 0; i < data.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const x = reverse ? 63 - (i % 64) : i % 64;
    data[i] = 40 + x * 2 + ((s >>> 24) % 40);
  }
  return { width: 64, height: 64, data };
};
const flat: GrayImage = { width: 64, height: 64, data: new Uint8Array(64 * 64).fill(128) };

function deps(over: Partial<PipelineDeps> & Pick<PipelineDeps, "gateway" | "adapter">): PipelineDeps {
  return {
    store: new MemoryStore(),
    profile,
    previewOf: async (a) => ({ mediaType: "image/jpeg", dataBase64: a.id }),
    ...over,
  };
}

describe("runJob", () => {
  it("culls, proposes, applies and stops at review, reporting fields the adapter ignores", async () => {
    const llm = fakeLlm();
    const { adapter, applied } = fakeAdapter();
    const grays: Record<string, GrayImage> = { a: noise(1), b: noise(2, true), soft: flat };
    const summary = await runJob(
      deps({ gateway: llm.gateway, adapter, grayOf: async (x) => grays[x.id]! }),
      { id: "j1", name: "wedding", assets: [asset("a"), asset("b"), asset("soft")] },
    );

    expect(summary.rejected).toEqual(["soft"]);
    expect(summary.awaitingReview.sort()).toEqual(["a", "b"]);
    expect(applied.map((x) => x.recipe.sourceStyleProfileId)).toEqual(["warm", "warm"]);
    expect(summary.unsupported.a).toEqual(["contrast"]);
    expect(llm.calls).not.toContain("soft");
  });

  it("isolates per-item failures and retries them from the stage that failed", async () => {
    const llm = fakeLlm(new Set(["b"]));
    const { adapter } = fakeAdapter();
    const d = deps({ gateway: llm.gateway, adapter });
    const input = { id: "j2", name: "x", assets: [asset("a"), asset("b")] };

    const first = await runJob(d, input);
    expect(first.awaitingReview).toEqual(["a"]);
    expect(first.failed).toEqual([{ assetId: "b", code: "LLM_AUTH", message: expect.any(String) }]);

    llm.denied.clear();
    const second = await runJob(d, { ...input, retryFailed: true });
    expect(second.awaitingReview.sort()).toEqual(["a", "b"]);
    expect(second.failed).toEqual([]);
    expect(llm.calls.filter((c) => c === "a")).toHaveLength(1);
  });

  it("resumes from a durable store without redoing LLM work", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vivah-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "jobs.db");
    const llm = fakeLlm();
    const { adapter } = fakeAdapter();
    const input = { id: "j3", name: "x", assets: [asset("a"), asset("b")] };

    const store1 = new SqliteStore(file);
    await runJob(deps({ gateway: llm.gateway, adapter, store: store1 }), input);
    store1.close();
    expect(llm.calls).toHaveLength(2);

    const store2 = new SqliteStore(file);
    const again = await runJob(deps({ gateway: llm.gateway, adapter, store: store2 }), input);
    store2.close();
    expect(again.awaitingReview.sort()).toEqual(["a", "b"]);
    expect(llm.calls).toHaveLength(2);
  });
});

describe("exportApproved", () => {
  it("exports only approved items and re-applies reviewer overrides", async () => {
    const llm = fakeLlm();
    const { adapter, applied } = fakeAdapter();
    const d = deps({ gateway: llm.gateway, adapter });
    const assets = [asset("a"), asset("b")];
    await runJob(d, { id: "j4", name: "x", assets });

    const override: EditRecipe = { version: "1.0", assetType: "photo", adjustments: { exposure: -1 } };
    const result = await exportApproved(d, "j4", assets, {
      approve: ["a"],
      overrides: { a: override },
      exportSpec: { format: "jpeg", outputDir: "/out" },
    });

    expect(result.exported.map((e) => e.assetId)).toEqual(["a"]);
    expect(result.overridden).toHaveLength(1);
    expect(result.overridden[0]!.final.adjustments.exposure).toBe(-1);
    expect(applied.at(-1)!.recipe.adjustments.exposure).toBe(-1);
    const items = d.store.listItems("j4");
    expect(items.find((i) => i.assetId === "b")!.state).toBe("review");
  });

  it("refuses an invalid override instead of exporting it", async () => {
    const llm = fakeLlm();
    const { adapter } = fakeAdapter();
    const d = deps({ gateway: llm.gateway, adapter });
    const assets = [asset("a")];
    await runJob(d, { id: "j5", name: "x", assets });

    const bad = { version: "1.0", assetType: "photo", adjustments: { exposure: 99 } } as EditRecipe;
    const result = await exportApproved(d, "j5", assets, { approve: ["a"], overrides: { a: bad }, exportSpec: { format: "jpeg", outputDir: "/out" } });
    expect(result.exported).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });

  describe("delivery step (afterExport)", () => {
    const spec: ExportSpec = { format: "jpeg", maxEdgePx: 2048, quality: 85, outputDir: "/out" };

    it("runs on every exported file with the requested spec before the item counts as exported", async () => {
      const { adapter } = fakeAdapter(new Set(), { exportResize: true });
      const d = deps({ gateway: fakeLlm().gateway, adapter });
      const assets = [asset("a"), asset("b")];
      await runJob(d, { id: "j6", name: "x", assets });

      const finished: { file: string; id: string; spec: ExportSpec; stateWhenCalled: string | undefined }[] = [];
      const result = await exportApproved(
        {
          ...d,
          afterExport: async (file, a, s) => {
            finished.push({ file, id: a.id, spec: s, stateWhenCalled: d.store.listItems("j6").find((i) => i.assetId === a.id)?.state });
          },
        },
        "j6",
        assets,
        { approve: ["a", "b"], exportSpec: spec },
      );

      expect(finished.map((f) => f.id).sort()).toEqual(["a", "b"]);
      expect(finished.every((f) => f.spec === spec && f.stateWhenCalled === "review")).toBe(true);
      expect(result.exported.map((e) => e.file).sort()).toEqual([path.join("/out", "a.jpg"), path.join("/out", "b.jpg")]);
    });

    it("fails only the item whose delivery step throws, with a stable code, and does not report it as exported", async () => {
      const { adapter } = fakeAdapter(new Set(), { exportResize: true });
      const d = deps({ gateway: fakeLlm().gateway, adapter });
      const assets = [asset("a"), asset("b")];
      await runJob(d, { id: "j7", name: "x", assets });

      const result = await exportApproved(
        { ...d, afterExport: async (_file, a) => { if (a.id === "b") throw new Error("could not decode"); } },
        "j7",
        assets,
        { approve: ["a", "b"], exportSpec: spec },
      );

      expect(result.exported.map((e) => e.assetId)).toEqual(["a"]);
      expect(result.failed).toEqual([{ assetId: "b", code: "EXPORT_FINISH_FAILED", message: "b.jpg was exported but could not be finished: could not decode" }]);
      expect(d.store.listItems("j7").find((i) => i.assetId === "b")).toMatchObject({ state: "failed", failedFrom: "review" });
    });

    it("hands full resolution to adapters that cannot resize and leaves the size to the delivery step", async () => {
      const { adapter, exportSpecs } = fakeAdapter(); // capability absent = cannot resize
      const d = deps({ gateway: fakeLlm().gateway, adapter });
      const assets = [asset("a")];
      await runJob(d, { id: "j8", name: "x", assets });

      let seen: ExportSpec | undefined;
      const result = await exportApproved({ ...d, afterExport: async (_f, _a, s) => void (seen = s) }, "j8", assets, { approve: ["a"], exportSpec: spec });
      expect(result.exported).toHaveLength(1);
      expect(exportSpecs).toEqual([{ format: "jpeg", quality: 85, outputDir: "/out", fileName: "a" }]);
      expect(seen!.maxEdgePx).toBe(2048);
    });

    it("passes the size straight to adapters that can resize", async () => {
      const { adapter, exportSpecs } = fakeAdapter(new Set(), { exportResize: true });
      const d = deps({ gateway: fakeLlm().gateway, adapter });
      const assets = [asset("a")];
      await runJob(d, { id: "j9", name: "x", assets });
      await exportApproved(d, "j9", assets, { approve: ["a"], exportSpec: spec });
      expect(exportSpecs).toEqual([{ ...spec, fileName: "a" }]);
    });

    it("refuses to export a size nobody can produce, before touching any photo", async () => {
      const { adapter, exportSpecs } = fakeAdapter();
      const d = deps({ gateway: fakeLlm().gateway, adapter });
      const assets = [asset("a")];
      await runJob(d, { id: "j10", name: "x", assets });

      await expect(exportApproved(d, "j10", assets, { approve: ["a"], exportSpec: spec })).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED", message: expect.stringMatching(/cannot resize/) });
      expect(exportSpecs).toEqual([]);
      expect(d.store.listItems("j10")[0]!.state).toBe("review");

      // Full resolution needs no delivery step.
      const full = await exportApproved(d, "j10", assets, { approve: ["a"], exportSpec: { format: "jpeg", outputDir: "/out" } });
      expect(full.exported).toHaveLength(1);
    });
  });

  describe("export file names", () => {
    const at = (file: string): AssetRef => ({ id: file, kind: "photo", path: `/shoot/${file}` });
    const spec: ExportSpec = { format: "jpeg", outputDir: "/out" };
    const pair = [at("IMG_001.cr3"), at("IMG_001.jpg"), at("IMG_002.cr3")];

    it("gives a RAW and its camera JPEG their own export files instead of letting one overwrite the other", async () => {
      const { adapter } = fakeAdapter();
      const d = deps({ gateway: fakeLlm().gateway, adapter });
      await runJob(d, { id: "n1", name: "x", assets: pair });

      const result = await exportApproved(d, "n1", pair, { approve: pair.map((a) => a.id), exportSpec: spec });
      expect(Object.fromEntries(result.exported.map((e) => [e.assetId, path.basename(e.file)]))).toEqual({
        "IMG_001.cr3": "IMG_001.jpg",
        "IMG_001.jpg": "IMG_001-jpg.jpg",
        "IMG_002.cr3": "IMG_002.jpg",
      });
      expect(result.failed).toEqual([]);
    });

    it("decides names over all of the job's photos, so a photo keeps its name whatever is approved with it", async () => {
      const { adapter } = fakeAdapter();
      const d = deps({ gateway: fakeLlm().gateway, adapter });
      await runJob(d, { id: "n2", name: "x", assets: pair });

      const onlyJpeg = await exportApproved(d, "n2", pair, { approve: ["IMG_001.jpg"], exportSpec: spec });
      expect(path.basename(onlyJpeg.exported[0]!.file)).toBe("IMG_001-jpg.jpg");
      const onlyRaw = await exportApproved(d, "n2", pair, { approve: ["IMG_001.cr3"], exportSpec: spec });
      expect(path.basename(onlyRaw.exported[0]!.file)).toBe("IMG_001.jpg");
    });

    it("deletes a file two photos were written to, and fails both, when an adapter ignores the file name", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "vivah-names-"));
      try {
        const { adapter } = fakeAdapter();
        const stubborn: EditorAdapter = {
          ...adapter,
          async export(asset, s) {
            // Ignores the file name for the RAW+JPEG pair, as a careless adapter would.
            const file = path.join(s.outputDir, asset.id.startsWith("IMG_001") ? "shared.jpg" : `${s.fileName}.jpg`);
            writeFileSync(file, `unfinished export of ${asset.id}`);
            return { assetId: asset.id, file };
          },
        };
        const d = deps({ gateway: fakeLlm().gateway, adapter: stubborn });
        await runJob(d, { id: "n3", name: "x", assets: pair });

        const result = await exportApproved(d, "n3", pair, { approve: pair.map((a) => a.id), exportSpec: { format: "jpeg", outputDir: dir } });
        expect(result.exported.map((e) => e.assetId)).toEqual(["IMG_002.cr3"]);
        expect(result.failed.map((f) => f.assetId).sort()).toEqual(["IMG_001.cr3", "IMG_001.jpg"]);
        expect(result.failed[0]).toMatchObject({ code: "ADAPTER_APPLY_FAILED", message: expect.stringContaining("shared.jpg") });
        expect(existsSync(path.join(dir, "shared.jpg"))).toBe(false);
        expect(existsSync(path.join(dir, "IMG_002.jpg"))).toBe(true);
        const failed = d.store.listItems("n3").filter((i) => i.state === "failed");
        expect(failed.map((i) => i.exportedFile)).toEqual([undefined, undefined]);
        expect(failed.every((i) => i.failedFrom === "review")).toBe(true);
        expect(result.failed[0]!.message).toContain("The file was removed");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("says so, and still fails the photos, when the shared file cannot be removed", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "vivah-names-"));
      try {
        const { adapter } = fakeAdapter();
        // A directory where the adapter claims to have written a file: removing it without `recursive` fails.
        const stubborn: EditorAdapter = {
          ...adapter,
          async export(asset, s) {
            const file = path.join(s.outputDir, "shared.jpg");
            mkdirSync(file, { recursive: true });
            return { assetId: asset.id, file };
          },
        };
        const d = deps({ gateway: fakeLlm().gateway, adapter: stubborn });
        const two = pair.slice(0, 2);
        await runJob(d, { id: "n4", name: "x", assets: two });

        const result = await exportApproved(d, "n4", two, { approve: two.map((a) => a.id), exportSpec: { format: "jpeg", outputDir: dir } });
        expect(result.exported).toEqual([]);
        expect(result.failed).toHaveLength(2);
        expect(result.failed[0]!.message).toMatch(/could not be removed: delete .*shared\.jpg yourself/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
