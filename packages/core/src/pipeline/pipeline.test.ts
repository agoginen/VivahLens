import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AssetRef, EditorAdapter } from "../adapters/editorAdapter.js";
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

function fakeAdapter(failApply = new Set<string>()) {
  const applied: { id: string; recipe: EditRecipe }[] = [];
  const adapter: EditorAdapter = {
    id: "fake-editor",
    capabilities: { mediaKinds: ["photo"], executionModel: "local-cli", requiresGuiOpen: false, os: ["windows", "macos"], supportedRecipeFields: ["exposure"] },
    detect: async () => ({}),
    async applyRecipe(asset, recipe) {
      if (failApply.has(asset.id)) throw new VivahError("ADAPTER_APPLY_FAILED", "boom");
      applied.push({ id: asset.id, recipe });
      return { assetId: asset.id, outputs: [`${asset.path}.sidecar`] };
    },
    async export(asset, spec) {
      return { assetId: asset.id, file: path.join(spec.outputDir, `${asset.id}.jpg`) };
    },
  };
  return { adapter, applied };
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
});
