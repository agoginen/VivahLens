import { describe, expect, it } from "vitest";
import type { AssetRef, EditorAdapter } from "../adapters/editorAdapter.js";
import { LlmGateway } from "../llm/gateway.js";
import type { LlmProvider } from "../llm/types.js";
import type { StyleProfile } from "../style/styleProfile.js";
import { MemoryStore } from "./libraryStore.js";
import { restoreRejected, retouchQueue, setRetouch } from "./review.js";
import { runJob } from "./runJob.js";

const asset = (id: string): AssetRef => ({ id, kind: "photo", path: `/shoot/${id}.cr3` });
const profile: StyleProfile = { id: "warm", name: "Warm", version: 1, summary: "warm", baseAdjustments: { exposure: 0.3 } };

function seeded() {
  const store = new MemoryStore();
  store.ensureJob({ id: "j", name: "j", adapterId: "x", styleProfileId: "warm", createdAt: "" });
  store.putItem({ jobId: "j", assetId: "soft", state: "rejected", rejectReason: "soft-focus", fingerprint: "fp-soft", attempts: 0 });
  store.putItem({ jobId: "j", assetId: "twin", state: "rejected", rejectReason: "duplicate-file", attempts: 0 });
  store.putItem({ jobId: "j", assetId: "fine", state: "review", attempts: 0 });
  return store;
}
const NOW = () => new Date("2026-03-01T10:00:00Z");

describe("restoreRejected", () => {
  it("returns rejected photos to the job, remembering why they were rejected, and writes the audit trail", () => {
    const store = seeded();
    const result = restoreRejected({ store, library: store, now: NOW }, "j", ["soft", "twin"]);
    expect(result).toEqual({ done: ["soft", "twin"], skipped: [] });
    const soft = store.listItems("j").find((i) => i.assetId === "soft")!;
    expect(soft).toMatchObject({ state: "culled", restoredFrom: "soft-focus", fingerprint: "fp-soft" });
    expect(soft.rejectReason).toBeUndefined();
    expect(store.listAudit({ jobId: "j" })).toEqual([
      { at: "2026-03-01T10:00:00.000Z", action: "restore-rejected", jobId: "j", assetId: "soft", meta: { was: "soft-focus" } },
      { at: "2026-03-01T10:00:00.000Z", action: "restore-rejected", jobId: "j", assetId: "twin", meta: { was: "duplicate-file" } },
    ]);
  });

  it("leaves photos that are not rejected, and ones that are not in the job, exactly as they were", () => {
    const store = seeded();
    const before = JSON.stringify(store.listItems("j"));
    const result = restoreRejected({ store }, "j", ["fine", "ghost"]);
    expect(result.done).toEqual([]);
    expect(result.skipped).toEqual([
      { assetId: "fine", reason: "it is review, not rejected" },
      { assetId: "ghost", reason: "not part of this job" },
    ]);
    expect(JSON.stringify(store.listItems("j"))).toBe(before);
  });

  it("restores each photo once however often it is named", () => {
    const store = seeded();
    expect(restoreRejected({ store, library: store }, "j", ["soft", "soft", "soft"]).done).toEqual(["soft"]);
    expect(store.listAudit({ jobId: "j" })).toHaveLength(1);
  });

  it("makes the next run edit the photo: it goes through the style and recipe stages like any other", async () => {
    const store = seeded();
    const asked: string[] = [];
    const provider: LlmProvider = {
      id: "fake",
      async complete(req) {
        asked.push(JSON.stringify(req.messages).slice(0, 40));
        return { text: JSON.stringify({ adjustments: { exposure: 0.5 }, confidence: 0.9 }) };
      },
    };
    const gateway = new LlmGateway().registerProvider(provider).setRoute("vision", { providerId: "fake", model: "m" });
    const adapter: EditorAdapter = {
      id: "x",
      capabilities: { mediaKinds: ["photo"], executionModel: "local-cli", requiresGuiOpen: false, os: ["windows"], supportedRecipeFields: ["exposure"] },
      detect: async () => ({}),
      applyRecipe: async (a) => ({ assetId: a.id, outputs: [] }),
    };
    restoreRejected({ store }, "j", ["soft"]);

    await runJob({ store, library: store, gateway, adapter, profile, describe: async (a) => ({ fingerprint: `fp-${a.id}` }), previewOf: async () => ({ mediaType: "image/jpeg", dataBase64: "x" }) }, { id: "j", name: "j", assets: [asset("soft"), asset("twin"), asset("fine")] });

    const states = Object.fromEntries(store.listItems("j").map((i) => [i.assetId, i.state]));
    expect(states).toEqual({ soft: "review", twin: "rejected", fine: "review" });
    expect(asked).toHaveLength(1);
  });
});

describe("retouch flags", () => {
  it("flags photos with an optional note, clears the flag, and lists the queue in job order", () => {
    const store = seeded();
    expect(setRetouch({ store, library: store, now: NOW }, "j", ["fine", "soft"], true, "  remove the exit sign  ").done).toEqual(["fine", "soft"]);
    expect(retouchQueue(store, "j")).toEqual([
      { assetId: "soft", state: "rejected", note: "remove the exit sign" },
      { assetId: "fine", state: "review", note: "remove the exit sign" },
    ]);

    setRetouch({ store, library: store }, "j", ["soft"], false);
    expect(retouchQueue(store, "j").map((q) => q.assetId)).toEqual(["fine"]);
    expect(store.listItems("j").find((i) => i.assetId === "soft")).not.toHaveProperty("retouchNote");
    expect(store.listAudit({ jobId: "j" }).map((e) => e.action)).toEqual(["retouch-flag", "retouch-flag", "retouch-unflag"]);
  });

  it("flags without a note, keeps every other field of the item, caps long notes, and skips unknown photos", () => {
    const store = seeded();
    const result = setRetouch({ store }, "j", ["soft", "ghost"], true, "x".repeat(900));
    expect(result.skipped).toEqual([{ assetId: "ghost", reason: "not part of this job" }]);
    const soft = store.listItems("j").find((i) => i.assetId === "soft")!;
    expect(soft.retouchNote).toHaveLength(500);
    expect(soft).toMatchObject({ state: "rejected", rejectReason: "soft-focus", fingerprint: "fp-soft", retouch: true });
    setRetouch({ store }, "j", ["fine"], true);
    expect(store.listItems("j").find((i) => i.assetId === "fine")).not.toHaveProperty("retouchNote");
  });
});
