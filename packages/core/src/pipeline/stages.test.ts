import { describe, expect, it, vi } from "vitest";
import type { AssetRef, EditorAdapter, ExportSpec, ImportResult } from "../adapters/editorAdapter.js";
import { VivahError } from "../errors.js";
import { LlmGateway } from "../llm/gateway.js";
import type { ContentPart, LlmProvider } from "../llm/types.js";
import type { EditRecipe } from "../recipe/editRecipe.js";
import type { StyleRetriever } from "../style/retrieval.js";
import type { StyleProfile } from "../style/styleProfile.js";
import { deliverExported, type Deliverer } from "./deliver.js";
import { MemoryStore } from "./libraryStore.js";
import { exportApproved, runJob, type PipelineDeps } from "./runJob.js";
import { jobStats } from "./stats.js";

const profile: StyleProfile = { id: "warm", name: "Warm", version: 1, summary: "warm", baseAdjustments: { exposure: 0.3 } };
const asset = (id: string): AssetRef => ({ id, kind: "photo", path: `/shoot/${id}.cr3` });
const fingerprintOf = async (a: AssetRef) => ({ fingerprint: `fp-${a.id}` });

/** Answers every recipe request, remembering which photo it was for and what examples came with it. */
function llm() {
  const asked: { id: string; examples: string[]; exampleTexts: string[] }[] = [];
  const provider: LlmProvider = {
    id: "fake",
    async complete(req) {
      const user = req.messages.find((m) => m.role === "user")!.content as ContentPart[];
      const images = user.filter((p): p is Extract<ContentPart, { type: "image" }> => p.type === "image").map((p) => p.dataBase64);
      const texts = user.flatMap((p) => (p.type === "text" ? [p.text] : []));
      asked.push({ id: images.at(-1)!, examples: images.slice(0, -1), exampleTexts: texts.filter((t) => t.startsWith("Finished example")) });
      return { text: JSON.stringify({ adjustments: { exposure: 0.5 }, confidence: 0.9 }) };
    },
  };
  return { gateway: new LlmGateway().registerProvider(provider).setRoute("vision", { providerId: "fake", model: "m" }), asked };
}

interface AdapterOptions {
  skip?: Record<string, string>;
  failImport?: boolean;
  replaced?: boolean;
}

function editor(opts: AdapterOptions = {}) {
  const calls = { applied: [] as string[], imported: [] as string[][], cancelled: [] as string[], contexts: [] as (string | undefined)[] };
  const adapter: EditorAdapter = {
    id: "fake-editor",
    capabilities: { mediaKinds: ["photo"], executionModel: "local-cli", requiresGuiOpen: false, os: ["windows"], supportedRecipeFields: ["exposure"], exportResize: true },
    detect: async () => ({}),
    async importAssets(assets): Promise<ImportResult> {
      calls.imported.push(assets.map((a) => a.id));
      if (opts.failImport) throw new VivahError("ADAPTER_EDITOR_NOT_RUNNING", "editor is closed");
      const skipped = assets.flatMap((a) => (opts.skip?.[a.id] ? [{ assetId: a.id, reason: opts.skip[a.id]! }] : []));
      return { imported: assets.filter((a) => !opts.skip?.[a.id]).map((a) => a.id), skipped };
    },
    async applyRecipe(a, _recipe, ctx) {
      calls.applied.push(a.id);
      calls.contexts.push(ctx?.jobId);
      return { assetId: a.id, outputs: [`${a.path}.xmp`], ...(opts.replaced && { replaced: [{ target: `${a.path}.xmp`, backup: `/backups/${a.id}.xmp` }] }) };
    },
    async export(a, spec) {
      return { assetId: a.id, file: `${spec.outputDir}/${spec.fileName ?? a.id}.jpg` };
    },
    async cancel(jobId) {
      calls.cancelled.push(jobId);
    },
  };
  return { adapter, calls };
}

function pipeline(store: MemoryStore, over: Partial<PipelineDeps> & Pick<PipelineDeps, "gateway" | "adapter">): PipelineDeps {
  return { store, library: store, profile, describe: fingerprintOf, previewOf: async (a) => ({ mediaType: "image/jpeg", dataBase64: a.id }), ...over };
}

const spec: ExportSpec = { format: "jpeg", outputDir: "/out" };

describe("recipes remembered per file", () => {
  it("does not ask the model again about a file it already edited under the same style version", async () => {
    const store = new MemoryStore();
    const { gateway, asked } = llm();
    const { adapter } = editor();

    await runJob(pipeline(store, { gateway, adapter }), { id: "j1", name: "a", assets: [asset("a"), asset("b")] });
    expect(asked).toHaveLength(2);

    await runJob(pipeline(store, { gateway, adapter }), { id: "j2", name: "again", assets: [asset("a"), asset("b")] });
    expect(asked).toHaveLength(2);
    expect(store.listItems("j2").map((i) => [i.assetId, i.recipeSource, i.state])).toEqual([
      ["a", "cache", "review"],
      ["b", "cache", "review"],
    ]);
  });

  it("asks again when the style has moved on, because the old proposal was for the old style", async () => {
    const store = new MemoryStore();
    const { gateway, asked } = llm();
    const { adapter } = editor();
    await runJob(pipeline(store, { gateway, adapter }), { id: "j1", name: "a", assets: [asset("a")] });

    await runJob(pipeline(store, { gateway, adapter, profile: { ...profile, version: 2 } }), { id: "j2", name: "b", assets: [asset("a")] });
    expect(asked).toHaveLength(2);
    expect(store.listItems("j2")[0]!.recipeSource).toBe("llm");
  });

  it("starts from what the reviewer settled on, whatever the style version", async () => {
    const store = new MemoryStore();
    const { gateway, asked } = llm();
    const { adapter } = editor();
    await runJob(pipeline(store, { gateway, adapter }), { id: "j1", name: "a", assets: [asset("a")] });
    const mine: EditRecipe = { version: "1.0", assetType: "photo", sourceStyleProfileId: "warm", adjustments: { exposure: -0.7 } };
    await exportApproved({ store, library: store, adapter }, "j1", [asset("a")], { approve: ["a"], overrides: { a: mine }, exportSpec: spec });

    await runJob(pipeline(store, { gateway, adapter, profile: { ...profile, version: 3 } }), { id: "j2", name: "b", assets: [asset("a")] });
    expect(asked).toHaveLength(1);
    const item = store.listItems("j2")[0]!;
    expect(item.recipeSource).toBe("override");
    expect(item.recipe!.adjustments.exposure).toBe(-0.7);
  });
});

describe("working offline", () => {
  it("applies what is already known, parks the rest without calling the model, and finishes them when back online", async () => {
    const store = new MemoryStore();
    const { gateway, asked } = llm();
    const { adapter, calls } = editor();
    await runJob(pipeline(store, { gateway, adapter }), { id: "j1", name: "a", assets: [asset("known")] });
    asked.length = 0;

    const input = { id: "j2", name: "b", assets: [asset("known"), asset("new")] };
    const offline = await runJob(pipeline(store, { gateway, adapter, offline: true }), input);
    expect(asked).toHaveLength(0);
    expect(offline.awaitingReview).toEqual(["known"]);
    expect(offline.waitingForModel).toEqual(["new"]);
    expect(offline.failed).toEqual([]);

    const online = await runJob(pipeline(store, { gateway, adapter }), input);
    expect(asked.map((q) => q.id)).toEqual(["new"]);
    expect(online.waitingForModel).toEqual([]);
    expect(online.awaitingReview.sort()).toEqual(["known", "new"]);
    expect(calls.applied.filter((id) => id === "known")).toHaveLength(2); // once per job, not again on resume
  });
});

describe("matching the photographer's own handling", () => {
  const retriever = (nearest: StyleRetriever["nearest"]): StyleRetriever => ({
    nearest,
    exemplars: async (ids) => ids.map((id) => ({ id, preview: { mediaType: "image/jpeg", dataBase64: `ref-${id}` }, adjustments: { exposure: 1.25 } })),
  });

  it("shows the model the nearest finished photos and what was done to them", async () => {
    const store = new MemoryStore();
    const { gateway, asked } = llm();
    const { adapter } = editor();
    const nearest = vi.fn(async (_a: AssetRef, count: number) => ["r1", "r2", "r3"].slice(0, count));

    await runJob(pipeline(store, { gateway, adapter, styleMatch: retriever(nearest), exampleCount: 2 }), { id: "j", name: "a", assets: [asset("a")] });

    expect(asked[0]!.examples).toEqual(["ref-r1", "ref-r2"]);
    expect(asked[0]!.exampleTexts[0]).toContain('"exposure":1.25');
    expect(store.listItems("j")[0]!.styleMatch).toEqual({ exemplarIds: ["r1", "r2"] });
  });

  it("carries on without examples when the lookup fails", async () => {
    const store = new MemoryStore();
    const { gateway, asked } = llm();
    const { adapter } = editor();
    const broken = retriever(async () => {
      throw new Error("index is corrupt");
    });

    const summary = await runJob(pipeline(store, { gateway, adapter, styleMatch: broken }), { id: "j", name: "a", assets: [asset("a")] });
    expect(summary.awaitingReview).toEqual(["a"]);
    expect(asked[0]!.examples).toEqual([]);
  });
});

describe("handing photos to the editor", () => {
  it("imports before applying and fails only the photos the editor refused", async () => {
    const store = new MemoryStore();
    const { gateway } = llm();
    const { adapter, calls } = editor({ skip: { bad: "unsupported format" } });

    const summary = await runJob(pipeline(store, { gateway, adapter }), { id: "j", name: "a", assets: [asset("good"), asset("bad")] });

    expect(calls.imported).toEqual([["good", "bad"]]);
    expect(calls.applied).toEqual(["good"]);
    expect(summary.awaitingReview).toEqual(["good"]);
    expect(summary.failed).toEqual([{ assetId: "bad", code: "ASSET_UNREADABLE", message: expect.stringContaining("unsupported format") }]);
  });

  it("fails every photo with the editor's own error when the import cannot run, and retries them from the recipe", async () => {
    const store = new MemoryStore();
    const { gateway, asked } = llm();
    const closed = editor({ failImport: true });
    const input = { id: "j", name: "a", assets: [asset("a"), asset("b")] };

    const first = await runJob(pipeline(store, { gateway, adapter: closed.adapter }), input);
    expect(first.failed.map((f) => f.code)).toEqual(["ADAPTER_EDITOR_NOT_RUNNING", "ADAPTER_EDITOR_NOT_RUNNING"]);
    expect(closed.calls.applied).toEqual([]);

    const open = editor();
    const second = await runJob(pipeline(store, { gateway, adapter: open.adapter }), { ...input, retryFailed: true });
    expect(second.awaitingReview.sort()).toEqual(["a", "b"]);
    expect(asked).toHaveLength(2); // the recipes were kept; only the apply was redone
  });

  it("re-applies a photo that was mid-apply when the app stopped, and keeps what the apply replaced so it can be undone", async () => {
    const store = new MemoryStore();
    const { gateway } = llm();
    const { adapter, calls } = editor({ replaced: true });
    const recipe: EditRecipe = { version: "1.0", assetType: "photo", adjustments: { exposure: 0.2 } };
    store.ensureJob({ id: "j", name: "a", adapterId: adapter.id, styleProfileId: "warm", createdAt: "t" });
    store.putItem({ jobId: "j", assetId: "a", state: "applying", recipe, attempts: 0, fingerprint: "fp-a" });

    const summary = await runJob(pipeline(store, { gateway, adapter }), { id: "j", name: "a", assets: [asset("a")] });

    expect(summary.awaitingReview).toEqual(["a"]);
    expect(calls.applied).toEqual(["a"]);
    expect(calls.contexts).toEqual(["j"]);
    expect(store.listUndo("j").map((u) => [u.assetId, u.target, u.backup])).toEqual([["a", "/shoot/a.cr3.xmp", "/backups/a.xmp"]]);
  });

  it("marks a photo as applying while the editor works on it, so a crash during the apply is visible on restart", async () => {
    const store = new MemoryStore();
    const { gateway } = llm();
    const { adapter } = editor();
    const during: string[] = [];
    const watching = { ...adapter, applyRecipe: async (a: AssetRef, recipe: EditRecipe) => { during.push(store.listItems("j").find((i) => i.assetId === a.id)!.state); return adapter.applyRecipe(a, recipe); } };

    await runJob(pipeline(store, { gateway, adapter: watching }), { id: "j", name: "a", assets: [asset("a")] });

    expect(during).toEqual(["applying"]);
    expect(store.listItems("j")[0]!.state).toBe("review");
  });

  it("tells the adapter to stop when the job is cancelled", async () => {
    const store = new MemoryStore();
    const { gateway } = llm();
    const { adapter, calls } = editor();
    const controller = new AbortController();
    const slow = { ...adapter, importAssets: async () => { controller.abort(); return { imported: [], skipped: [] }; } };

    await runJob(pipeline(store, { gateway, adapter: slow, signal: controller.signal }), { id: "j", name: "a", assets: [asset("a")] }).catch(() => undefined);

    expect(calls.cancelled).toEqual(["j"]);
  });
});

describe("delivering what was exported", () => {
  const exportedJob = async (assets: string[]) => {
    const store = new MemoryStore();
    const { gateway } = llm();
    const { adapter } = editor();
    const all = assets.map(asset);
    await runJob(pipeline(store, { gateway, adapter }), { id: "j", name: "a", assets: all });
    await exportApproved({ store, library: store, adapter }, "j", all, { approve: assets, exportSpec: spec });
    return { store, all };
  };

  it("moves exported photos to delivered, records where each went, and counts them as approved", async () => {
    const { store, all } = await exportedJob(["a", "b"]);
    const sent: string[] = [];
    const deliverer: Deliverer = {
      id: "folder",
      async deliver(file, a) {
        sent.push(file);
        return { destination: `/client/${a.id}.jpg`, bytes: 10 };
      },
    };

    const result = await deliverExported({ store, library: store }, "j", all, deliverer);

    expect(result.delivered.map((d) => d.destination)).toEqual(["/client/a.jpg", "/client/b.jpg"]);
    expect(sent).toEqual(["/out/a.jpg", "/out/b.jpg"]);
    expect(store.listItems("j").map((i) => [i.state, i.deliveredTo])).toEqual([["delivered", "/client/a.jpg"], ["delivered", "/client/b.jpg"]]);
    expect(store.listDeliveries("j").map((d) => [d.assetId, d.bytes])).toEqual([["a", 10], ["b", 10]]);
    expect(jobStats(store, "j", store).approved).toBe(2);
  });

  it("never delivers a photo that was not exported, keeps a failed delivery retryable, and delivers it on the next try", async () => {
    const { store, all } = await exportedJob(["a", "b"]);
    store.putItem({ ...store.listItems("j").find((i) => i.assetId === "b")!, state: "review", exportedFile: undefined });
    let down = true;
    const sent: string[] = [];
    const deliverer: Deliverer = {
      id: "sftp",
      async deliver(file) {
        if (down) throw new Error("connection reset");
        sent.push(file);
        return { destination: `sftp://host${file}` };
      },
    };

    const first = await deliverExported({ store, library: store }, "j", all, deliverer);
    expect(first.delivered).toEqual([]);
    expect(first.failed).toEqual([{ assetId: "a", code: "DELIVERY_FAILED", message: expect.stringContaining("connection reset") }]);
    expect(store.listItems("j").find((i) => i.assetId === "a")!.exportedFile).toBe("/out/a.jpg");

    down = false;
    const second = await deliverExported({ store, library: store }, "j", all, deliverer);
    expect(second.delivered).toEqual([{ assetId: "a", destination: "sftp://host/out/a.jpg" }]);
    expect(second.failed).toEqual([]);
    expect(sent).toEqual(["/out/a.jpg"]);
    expect(store.listItems("j").find((i) => i.assetId === "b")!.state).toBe("review");
  });
});
