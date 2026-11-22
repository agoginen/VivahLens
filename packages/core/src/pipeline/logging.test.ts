import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AssetRef, EditorAdapter } from "../adapters/editorAdapter.js";
import { VivahError } from "../errors.js";
import { LlmGateway, type LlmCallEvent } from "../llm/gateway.js";
import type { LlmProvider } from "../llm/types.js";
import { createLogger, memoryLogger } from "../observability/logger.js";
import { recipeHash } from "../recipe/hash.js";
import type { StyleProfile } from "../style/styleProfile.js";
import { MemoryStore } from "./libraryStore.js";
import { exportApproved, runJob } from "./runJob.js";

const profile: StyleProfile = { id: "warm", name: "Warm", version: 1, summary: "warm", baseAdjustments: { exposure: 0.3 } };
const HOME = "C:\\Users\\Jane Doe";
const asset = (id: string): AssetRef => ({ id, kind: "photo", path: `${HOME}\\wedding\\${id}.cr3` });
const PREVIEW = "QUJD".repeat(3000);

function setup(opts: { failApply?: string; failLlm?: boolean } = {}) {
  const calls: LlmCallEvent[] = [];
  let attempts = 0;
  const provider: LlmProvider = {
    id: "fake",
    async complete() {
      attempts++;
      if (opts.failLlm && attempts === 1) throw new VivahError("LLM_RATE_LIMIT", "slow down", true, 1);
      return { text: JSON.stringify({ adjustments: { exposure: 0.5 }, confidence: 0.8 }), usage: { inputTokens: 1000, outputTokens: 200 } };
    },
  };
  const gateway = new LlmGateway({
    onCall: (e) => calls.push(e),
    prices: { effectiveFrom: "2026-01-01", models: { m: { inputPerMTok: 1, outputPerMTok: 4 } } },
    retry: { attempts: 2, baseDelayMs: 1 },
    sleep: async () => undefined,
  })
    .registerProvider(provider)
    .setRoute("vision", { providerId: "fake", model: "m" });
  const adapter: EditorAdapter = {
    id: "fake-editor",
    capabilities: { mediaKinds: ["photo"], executionModel: "local-cli", requiresGuiOpen: false, os: ["windows"], supportedRecipeFields: ["exposure"] },
    detect: async () => ({}),
    async applyRecipe(a) {
      if (a.id === opts.failApply) throw new VivahError("ADAPTER_APPLY_FAILED", `could not write ${a.path} using key sk-live-abcdefghijklmnop123`);
      return { assetId: a.id, outputs: [`${a.path}.xmp`] };
    },
    async export(a, spec) {
      return { assetId: a.id, file: path.join(spec.outputDir, `${a.id}.jpg`) };
    },
  };
  const logger = memoryLogger({ redact: { home: HOME } });
  const deps = { store: new MemoryStore(), gateway, adapter, profile, previewOf: async () => ({ mediaType: "image/jpeg" as const, dataBase64: PREVIEW }), logger };
  return { deps, logger, calls, adapter };
}

describe("the structured log of a run", () => {
  it("records the job, each photo's recipe and apply with its hash, adapter and time, and the hand-over to review", async () => {
    const { deps, logger } = setup();
    await runJob(deps, { id: "j1", name: "wedding", assets: [asset("a"), asset("b")] });

    const events = logger.records.map((r) => r.event);
    expect(events[0]).toBe("job-started");
    expect(events.at(-1)).toBe("job-ready-for-review");
    expect(logger.records[0]).toMatchObject({ jobId: "j1", photos: 2, adapter: "fake-editor", profile: "warm@1" });
    expect(logger.records.at(-1)).toMatchObject({ jobId: "j1", awaitingReview: 2, failed: 0 });

    const recipe = logger.records.find((r) => r.event === "item.done" && r.stage === "recipe-generated" && r.assetId === "a")!;
    expect(recipe).toMatchObject({ jobId: "j1", source: "llm", confidence: 0.8 });
    expect(recipe.recipeHash).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof recipe.durationMs).toBe("number");

    const applied = logger.records.find((r) => r.event === "item.done" && r.stage === "review" && r.assetId === "a")!;
    expect(applied).toMatchObject({ adapter: "fake-editor", warnings: 0, replaced: 0, recipeHash: recipe.recipeHash });
    // The hash in the log is the hash of the recipe that was stored and applied, so a support case can match them.
    expect(recipe.recipeHash).toBe(recipeHash(deps.store.listItems("j1").find((i) => i.assetId === "a")!.recipe!));
  });

  it("records a photo that failed with its stage, code and attempt, and keeps secrets and the account name out of the message", async () => {
    const { deps, logger } = setup({ failApply: "b" });
    await runJob(deps, { id: "j2", name: "x", assets: [asset("a"), asset("b")] });

    const failed = logger.records.find((r) => r.event === "item.failed")!;
    expect(failed).toMatchObject({ level: "warn", jobId: "j2", assetId: "b", stage: "review", code: "ADAPTER_APPLY_FAILED", attempts: 1 });
    expect(failed.message).toBe("could not write ~\\wedding\\b.cr3 using key [redacted]");
    expect(logger.records.at(-1)).toMatchObject({ event: "job-ready-for-review", awaitingReview: 1, failed: 1 });
  });

  it("never lets a preview, a key or the account name reach the log", async () => {
    const { deps, logger } = setup({ failApply: "a" });
    await runJob(deps, { id: "j3", name: "x", assets: [asset("a")] });
    const text = JSON.stringify(logger.records);
    expect(text).not.toContain(PREVIEW.slice(0, 40));
    expect(text).not.toContain("sk-live");
    expect(text).not.toContain("Jane");
  });

  it("logs each model call with provider, model, time, tokens and cost, and a failed attempt with its error code", async () => {
    const { deps, calls } = setup({ failLlm: true });
    await runJob(deps, { id: "j4", name: "x", assets: [asset("a")] });
    expect(calls.map((c) => [c.outcome, c.errorCode])).toEqual([["failed", "LLM_RATE_LIMIT"], ["ok", undefined]]);
    expect(calls[1]).toMatchObject({ provider: "fake", model: "m", purpose: "recipe", inputTokens: 1000, outputTokens: 200 });
    expect(calls[1]!.costUsd).toBeCloseTo(0.0018, 6);
    expect(calls[1]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("logs the review decision and each exported or approved photo", async () => {
    const { deps, logger } = setup();
    await runJob(deps, { id: "j5", name: "x", assets: [asset("a"), asset("b")] });
    logger.records.length = 0;
    await exportApproved(deps, "j5", [asset("a"), asset("b")], { approve: ["a"], exportSpec: { format: "jpeg", outputDir: "C:\\Users\\Jane Doe\\out" } });
    expect(logger.records.map((r) => r.event)).toEqual(["item.done", "review-decision"]);
    expect(logger.records[0]).toMatchObject({ stage: "exported", assetId: "a", outcome: "exported", overridden: false, adapter: "fake-editor", file: "~\\out\\a.jpg" });
    expect(logger.records[1]).toMatchObject({ jobId: "j5", approved: 0, exported: 1 });
  });

  it("does not change what the run does, whether there is a logger, none, or one whose sink throws", async () => {
    const plain = setup();
    const { logger: _unused, ...withoutLogger } = plain.deps;
    const a = await runJob(withoutLogger, { id: "j6", name: "x", assets: [asset("a")] });

    const broken = setup();
    const noisy = createLogger({ write: () => { throw new Error("disk full"); } });
    const b = await runJob({ ...broken.deps, logger: noisy }, { id: "j6", name: "x", assets: [asset("a")] });
    expect(b).toEqual(a);
  });
});
