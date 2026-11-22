// A review page with made-up photos, for trying the interface by hand (and for checking it in a browser):
//   npm run build && node scripts/review-demo.mjs
// The photos are generated, the edits are drawn by the real renderer, and "Submit decisions" exports into a temp folder.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { MemoryStore } from "../packages/core/dist/index.js";
import { loadPreview } from "../packages/ingest/dist/index.js";
import { createPreviewRenderer, RenderAdapter } from "../packages/render/dist/index.js";
import { startReviewServer } from "../packages/review/dist/index.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "vivah-demo-"));
const out = path.join(dir, "out");

/** A picture with a sky, a hillside, skin-coloured and saturated patches, so that every slider shows something. */
function scene(name, { width = 480, height = 320, warm = 0 }) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = y / height;
      let [r, g, b] = t < 0.55 ? [90 + 110 * t + warm, 140 + 60 * t, 220 - 60 * t] : [60, 110 - 40 * (t - 0.55), 50];
      if (x > width * 0.12 && x < width * 0.3 && y > height * 0.4 && y < height * 0.8) [r, g, b] = [215, 160, 130];
      if (x > width * 0.62 && x < width * 0.82 && y > height * 0.15 && y < height * 0.4) [r, g, b] = [235, 60, 50];
      if ((x + y) % 7 === 0) r += 6;
      data.set([Math.min(255, r), Math.min(255, g), Math.min(255, b), 255], (y * width + x) * 4);
    }
  }
  const file = path.join(dir, name);
  writeFileSync(file, jpeg.encode({ data, width, height }, 90).data);
  return { id: name, kind: "photo", path: file };
}

const assets = [
  scene("IMG_0101.jpg", { warm: 0 }),
  scene("IMG_0102.jpg", { warm: 25 }),
  scene("IMG_0103.jpg", { width: 320, height: 480 }),
  scene("IMG_0104.jpg", {}),
  scene("IMG_0105.jpg", {}),
  scene("IMG_0106.jpg", {}),
];
const recipe = (adjustments) => ({ version: "1.0", assetType: "photo", sourceStyleProfileId: "demo", adjustments });

const store = new MemoryStore();
store.ensureJob({ id: "demo", name: "demo", adapterId: "builtin-render", styleProfileId: "demo", createdAt: new Date().toISOString() });
const put = (item, state, extra = {}) => store.putItem({ jobId: "demo", assetId: item.id, state, attempts: 0, ...extra });
put(assets[0], "review", { recipe: recipe({ exposure: 0.4, contrast: 12, vibrance: 20, shadows: 25, whiteBalance: { tempK: 6200 } }), recipeSource: "llm", outlierFields: ["exposure"] });
put(assets[1], "review", { recipe: recipe({ exposure: -0.3, highlights: -35, clarity: 25, hsl: { orange: { saturation: -15 } }, vignette: { amount: -25 } }), recipeSource: "cache" });
put(assets[2], "review", { recipe: recipe({ exposure: 0.2, saturation: 15, crop: { aspectRatio: "4:5" }, lutRef: "warm.cube" }), recipeSource: "override" });
put(assets[3], "approved", { recipe: recipe({ exposure: 0.1 }) });
put(assets[4], "rejected", { rejectReason: "blurry" });
put(assets[5], "failed", { errorMessage: "The editor could not read this file", errorCode: "ADAPTER_APPLY_FAILED" });
store.recordOutbound({ at: new Date().toISOString(), jobId: "demo", provider: "demo-cloud-model", purpose: "recipe", images: 4, imageBytes: 612_000, maxEdgePx: 2048 });

const adapter = new RenderAdapter({ backupDir: path.join(dir, "backups") });
// The pipeline applies every proposed recipe before review; do the same for these made-up ones so "Submit decisions" can export them.
for (const item of store.listItems("demo")) {
  if (item.recipe) await adapter.applyRecipe(assets.find((a) => a.id === item.assetId), item.recipe, { jobId: "demo" });
}
const server = await startReviewServer({
  store,
  library: store,
  jobId: "demo",
  assets,
  adapter,
  profile: { id: "demo", name: "Demo style", version: 1, summary: "", baseAdjustments: { exposure: 0 } },
  previewOf: (asset) => loadPreview(asset, { maxEdge: 1024 }),
  renderPreview: createPreviewRenderer({ maxEdge: 1024 }),
  exportSpec: { format: "jpeg", outputDir: out, quality: 88 },
});
console.log(`Review page: ${server.url}\nPhotos and exports are under ${dir}\nPress Ctrl-C to stop.`);
process.on("SIGINT", () => server.close().then(() => process.exit(0)));
