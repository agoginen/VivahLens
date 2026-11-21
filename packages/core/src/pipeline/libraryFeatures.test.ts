import { describe, expect, it } from "vitest";
import type { AssetRef, EditorAdapter } from "../adapters/editorAdapter.js";
import { LlmGateway } from "../llm/gateway.js";
import type { LlmProvider } from "../llm/types.js";
import type { EditRecipe } from "../recipe/editRecipe.js";
import type { StyleProfile } from "../style/styleProfile.js";
import { MemoryStore } from "./libraryStore.js";
import { exportApproved, runJob, type PipelineDeps } from "./runJob.js";
import { jobStats } from "./stats.js";

const profile: StyleProfile = { id: "warm", name: "Warm", version: 1, summary: "warm", baseAdjustments: { exposure: 0.3 } };
const asset = (id: string): AssetRef => ({ id, kind: "photo", path: `/shoot/${id}` });

/** Replies per photo (identified by the preview payload) and records every system prompt it saw. */
function llm(exposureOf: (id: string) => number = () => 0.3) {
  const prompts = new Map<string, string>();
  const provider: LlmProvider = {
    id: "fake",
    async complete(req) {
      const system = req.messages.find((m) => m.role === "system")!.content as string;
      const user = req.messages.find((m) => m.role === "user")!.content;
      const id = (Array.isArray(user) ? user.find((p) => p.type === "image") : undefined) as { dataBase64: string } | undefined;
      prompts.set(id!.dataBase64, system);
      return { text: JSON.stringify({ adjustments: { exposure: exposureOf(id!.dataBase64), contrast: 10 }, confidence: 0.8 }) };
    },
  };
  return { gateway: new LlmGateway().registerProvider(provider).setRoute("vision", { providerId: "fake", model: "m" }), prompts };
}

const adapter: EditorAdapter = {
  id: "fake-editor",
  capabilities: { mediaKinds: ["photo"], executionModel: "local-cli", requiresGuiOpen: false, os: ["windows"], supportedRecipeFields: ["exposure", "contrast"] },
  detect: async () => ({}),
  applyRecipe: async (a) => ({ assetId: a.id, outputs: [] }),
};

function deps(store: MemoryStore, gateway: LlmGateway, over: Partial<PipelineDeps> = {}): PipelineDeps {
  return { store, library: store, gateway, adapter, profile, previewOf: async (a) => ({ mediaType: "image/jpeg", dataBase64: a.id }), ...over };
}

describe("duplicate files and the asset library", () => {
  it("rejects a byte-identical copy within a job and remembers files across jobs", async () => {
    const store = new MemoryStore();
    const { gateway } = llm();
    const describe_ = async (a: AssetRef) => ({ fingerprint: a.id === "copy.cr3" ? "same" : a.id === "orig.cr3" ? "same" : `fp-${a.id}`, exif: { model: "R5" } });

    const first = await runJob(deps(store, gateway, { describe: describe_ }), { id: "j1", name: "x", assets: [asset("orig.cr3"), asset("copy.cr3"), asset("other.cr3")] });
    expect(first.rejected).toEqual(["copy.cr3"]);
    expect(first.rejectReasons["copy.cr3"]).toBe("duplicate-file");
    expect(first.awaitingReview.sort()).toEqual(["orig.cr3", "other.cr3"]);

    const second = await runJob(deps(store, gateway, { describe: describe_ }), { id: "j2", name: "again", assets: [asset("orig.cr3")] });
    expect(second.seenBefore).toEqual({ "orig.cr3": "j1" });
    // Re-seeing the same path keeps the first record rather than adding a duplicate.
    expect(store.findAssetsByFingerprint("same").map((a) => [a.path, a.firstSeenJob])).toEqual([["/shoot/orig.cr3", "j1"]]);
  });
});

describe("scene grouping and album consistency", () => {
  it("groups photos by lighting, tells the LLM which group each belongs to, and flags the odd one out", async () => {
    const store = new MemoryStore();
    const ids = ["i1", "i2", "i3", "i4", "i5", "o1", "o2", "o3", "o4", "o5"];
    const { gateway, prompts } = llm((id) => (id === "o3" ? 3 : 0.3));
    const scenes: Record<string, { meanLuma: number; tempK: number }> = Object.fromEntries(
      ids.map((id) => [id, id.startsWith("i") ? { meanLuma: 70, tempK: 3200 } : { meanLuma: 170, tempK: 5600 }]),
    );

    const summary = await runJob(deps(store, gateway, { sceneOf: async (a) => scenes[a.id]! }), { id: "j", name: "x", assets: ids.map(asset) });

    const items = store.listItems("j");
    const sceneOf = (prefix: string) => new Set(items.filter((i) => i.assetId.startsWith(prefix)).map((i) => i.sceneId));
    expect(sceneOf("i").size).toBe(1);
    expect(sceneOf("o").size).toBe(1);
    expect(sceneOf("i")).not.toEqual(sceneOf("o"));
    expect(prompts.get("i1")).toContain("lighting group 1 of 2");
    expect(prompts.get("o1")).toContain("lighting group 2 of 2");

    expect(summary.outliers).toEqual({ o3: ["exposure"] });
    expect(store.listItems("j").find((i) => i.assetId === "o3")!.recipe!.adjustments.exposure).toBe(3);
  });

  it("does not fail a photo when scene analysis fails", async () => {
    const store = new MemoryStore();
    const { gateway } = llm();
    const summary = await runJob(deps(store, gateway, { sceneOf: async () => { throw new Error("decode"); } }), { id: "j", name: "x", assets: [asset("a")] });
    expect(summary.awaitingReview).toEqual(["a"]);
    expect(summary.failed).toEqual([]);
  });
});

describe("audit trail, overrides and acceptance stats", () => {
  it("records what happened and computes the acceptance rate from reviewer corrections", async () => {
    const store = new MemoryStore();
    const { gateway } = llm();
    const assets = ["a", "b", "c", "d"].map(asset);
    await runJob(deps(store, gateway), { id: "j", name: "x", assets });

    const corrected: EditRecipe = { version: "1.0", assetType: "photo", adjustments: { exposure: 1, contrast: 10 } };
    await exportApproved({ store, library: store, adapter }, "j", assets, { approve: ["a", "b", "c"], overrides: { c: corrected } });

    expect(store.listOverrides("j").map((o) => [o.assetId, o.path, o.oldValue, o.newValue])).toEqual([["c", "exposure", 0.3, 1]]);
    expect(store.listAudit({ jobId: "j" }).map((e) => e.action)).toEqual(["job-started", "job-ready-for-review", "review-decision"]);
    expect(store.loadProfile("warm")!.version).toBe(1);

    const stats = jobStats(store, "j", store);
    expect(stats).toMatchObject({ total: 4, awaitingReview: 1, approved: 3, approvedUnchanged: 2, overridden: 1, correctionsByField: { exposure: 1 } });
    expect(stats.acceptanceRate).toBeCloseTo(2 / 3);
  });

  it("reports no acceptance rate until something is approved", () => {
    expect(jobStats(new MemoryStore(), "empty").acceptanceRate).toBeUndefined();
  });
});
