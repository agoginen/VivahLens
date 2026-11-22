// Runs one big job against a SQLite file and exits when it is done. The resumability test starts it, kills it part way with
// SIGKILL, and then checks what the database held (plan §7h: "a batch of 1,500 survives kill -9 with zero lost completed items").
//   node scripts/resume-worker.mjs <db file> <photos> <llm milliseconds per call>
import { LlmGateway, runJob, SqliteStore } from "@vivahlens/core";

const [, , file, photosArg, delayArg] = process.argv;
const photos = Number(photosArg);
const delayMs = Number(delayArg);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const assets = Array.from({ length: photos }, (_, i) => {
  const id = `IMG_${String(i).padStart(4, "0")}.CR3`;
  return { id, kind: "photo", path: `/shoot/${id}` };
});
const gateway = new LlmGateway()
  .registerProvider({
    id: "slow",
    async complete() {
      await sleep(delayMs);
      return { text: JSON.stringify({ adjustments: { exposure: 0.3, contrast: 8 }, confidence: 0.7 }) };
    },
  })
  .setRoute("vision", { providerId: "slow", model: "m" });
const adapter = {
  id: "fake-editor",
  capabilities: { mediaKinds: ["photo"], executionModel: "local-cli", requiresGuiOpen: false, os: ["windows"], supportedRecipeFields: ["exposure", "contrast"] },
  detect: async () => ({}),
  applyRecipe: async (asset) => ({ assetId: asset.id, outputs: [] }),
};

const store = new SqliteStore(file);
const summary = await runJob(
  { store, library: store, gateway, adapter, profile: { id: "warm", name: "Warm", version: 1, summary: "warm", baseAdjustments: { exposure: 0.2 } }, previewOf: async (a) => ({ mediaType: "image/jpeg", dataBase64: a.id }), concurrency: 4 },
  { id: "big", name: "big", assets },
);
store.close();
console.log(JSON.stringify({ done: true, awaitingReview: summary.awaitingReview.length }));
