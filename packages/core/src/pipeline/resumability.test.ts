import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { LlmGateway } from "../llm/gateway.js";
import type { EditorAdapter } from "../adapters/editorAdapter.js";
import { runJob } from "./runJob.js";
import { SqliteStore } from "./sqliteStore.js";

// The worker runs against the built packages, as the agent does for real; without a build there is no process to kill.
const worker = fileURLToPath(new URL("../../../../scripts/resume-worker.mjs", import.meta.url));
const built = existsSync(fileURLToPath(new URL("../../dist/index.js", import.meta.url)));

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const dir = mkdtempSync(path.join(tmpdir(), "vivah-kill-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PHOTOS = 1500;
type Row = { state: string; body: string };

/** The job's items as the file holds them right now, read without taking part in the writer's transactions. `body` is the item's whole record. */
function items(file: string): Map<string, Row> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("SELECT asset_id, state, body FROM job_item WHERE job_id = 'big'").all() as { asset_id: string; state: string; body: string }[];
    return new Map(rows.map((r) => [r.asset_id, { state: r.state, body: r.body }]));
  } finally {
    db.close();
  }
}
const count = (map: Map<string, Row>, ...states: string[]) => [...map.values()].filter((i) => states.includes(i.state)).length;
const recipeOf = (row: Row) => JSON.stringify((JSON.parse(row.body) as { recipe?: unknown }).recipe);

/** Starts the worker on a new database and kills it the moment `reached` says it is far enough along: no chance to clean up, as in a crash. */
async function killWhen(name: string, reached: (items: Map<string, Row>) => boolean): Promise<string> {
  const file = path.join(dir, `${name}.db`);
  const child = spawn(process.execPath, [worker, file, String(PHOTOS), "4"], { stdio: ["ignore", "pipe", "pipe"] });
  let finishedOnItsOwn = false;
  let stderr = "";
  let stopped: number | null | undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    if (String(chunk).includes('"done":true')) finishedOnItsOwn = true;
  });
  child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
  child.once("exit", (code) => (stopped = code));

  // Says what went wrong when the worker ends by itself, rather than waiting for a state it can no longer reach.
  const endedEarly = () =>
    new Error(finishedOnItsOwn ? "the worker finished before it could be killed; make the batch bigger or the calls slower" : `the worker stopped by itself (exit code ${stopped}) before it could be killed: ${stderr.trim().slice(0, 600)}`);

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (stopped !== undefined) throw endedEarly();
    if (existsSync(file)) {
      try {
        if (reached(items(file))) break;
      } catch {
        // The worker is still creating its tables.
      }
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`the worker was not far enough along after 90 s: ${stderr.trim().slice(0, 600)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (stopped !== undefined) throw endedEarly();
  child.kill("SIGKILL");
  await once(child, "exit");
  expect(finishedOnItsOwn, "the worker finished before it could be killed; make the batch bigger or the calls slower").toBe(false);
  return file;
}

/** Opens what the kill left, resumes the same job, and reports how many model calls the resume made. */
async function resume(file: string): Promise<{ calls: number; failed: number; awaitingReview: number }> {
  let calls = 0;
  const gateway = new LlmGateway()
    .registerProvider({ id: "p", complete: async () => ((calls += 1), { text: JSON.stringify({ adjustments: { exposure: 0.3, contrast: 8 }, confidence: 0.7 }) }) })
    .setRoute("vision", { providerId: "p", model: "m" });
  const adapter: EditorAdapter = {
    id: "fake-editor",
    capabilities: { mediaKinds: ["photo"], executionModel: "local-cli", requiresGuiOpen: false, os: ["windows"], supportedRecipeFields: ["exposure", "contrast"] },
    detect: async () => ({}),
    applyRecipe: async (a) => ({ assetId: a.id, outputs: [] }),
  };
  const store = new SqliteStore(file);
  const assets = Array.from({ length: PHOTOS }, (_, i) => ({ id: `IMG_${String(i).padStart(4, "0")}.CR3`, kind: "photo" as const, path: `/shoot/IMG_${i}.CR3` }));
  const summary = await runJob(
    { store, library: store, gateway, adapter, profile: { id: "warm", name: "Warm", version: 1, summary: "warm", baseAdjustments: { exposure: 0.2 } }, previewOf: async (a) => ({ mediaType: "image/jpeg", dataBase64: a.id }), concurrency: 4 },
    { id: "big", name: "big", assets },
  );
  store.close();
  return { calls, failed: summary.failed.length, awaitingReview: summary.awaitingReview.length };
}

function assertIntact(file: string): void {
  const raw = new DatabaseSync(file, { readOnly: true });
  expect((raw.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
  raw.close();
}

describe.skipIf(!built)(`a batch of ${PHOTOS} that is killed part way`, () => {
  it("killed while asking the model: keeps every recipe it had, and asks the model only for the photos that had none", async () => {
    const file = await killWhen("model-stage", (m) => count(m, "recipe-generated") >= 300);
    assertIntact(file);

    const afterKill = items(file);
    expect(afterKill.size).toBe(PHOTOS);
    const withRecipe = [...afterKill].filter(([, row]) => ["recipe-generated", "applying", "review"].includes(row.state));
    const needingTheModel = count(afterKill, "queued", "culled", "style-matched");
    expect(withRecipe.length).toBeGreaterThanOrEqual(300);
    expect(needingTheModel).toBeGreaterThan(0);
    expect(withRecipe.length + needingTheModel).toBe(PHOTOS);

    const outcome = await resume(file);
    expect(outcome.calls).toBe(needingTheModel);
    expect(outcome.failed).toBe(0);
    expect(outcome.awaitingReview).toBe(PHOTOS);

    // Every recipe that existed at the kill is exactly the one that was applied.
    const afterResume = items(file);
    for (const [id, before] of withRecipe) expect(recipeOf(afterResume.get(id)!), id).toBe(recipeOf(before));
    expect(count(afterResume, "review")).toBe(PHOTOS);
  }, 180_000);

  it("killed while applying edits: keeps every photo already applied untouched, and asks the model for nothing", async () => {
    const file = await killWhen("apply-stage", (m) => count(m, "review") >= 300);
    assertIntact(file);

    const afterKill = items(file);
    expect(afterKill.size).toBe(PHOTOS);
    const finished = [...afterKill].filter(([, row]) => row.state === "review");
    expect(finished.length).toBeGreaterThanOrEqual(300);
    expect(finished.length).toBeLessThan(PHOTOS);
    expect(count(afterKill, "queued", "culled", "style-matched")).toBe(0);

    const outcome = await resume(file);
    expect(outcome.calls).toBe(0);
    expect(outcome.failed).toBe(0);
    expect(outcome.awaitingReview).toBe(PHOTOS);

    // The photos that were finished are not just still there: their records are byte for byte what they were.
    const afterResume = items(file);
    for (const [id, before] of finished) expect(afterResume.get(id), id).toEqual(before);
    expect(count(afterResume, "review")).toBe(PHOTOS);
  }, 180_000);
});
