#!/usr/bin/env node
// Measures what plan §7h promises that can be measured on this machine, against the built packages:
//   node scripts/bench.mjs [--photos 40] [--edge 2048]
// It generates its own photos and uses the mock model, so nothing leaves the computer and no model latency is included
// (the plan's targets exclude it). Numbers are for the machine that ran it, and are printed with its specification.
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { loadPreview } from "@vivahlens/ingest";

const { values } = parseArgs({ options: { photos: { type: "string", default: "40" }, edge: { type: "string", default: "2048" } } });
const PHOTOS = Number(values.photos);
const EDGE = Number(values.edge);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages/cli/dist/main.js");
const work = mkdtempSync(path.join(os.tmpdir(), "vivah-bench-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
const median = (xs) => percentile(xs, 50);
const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`;
const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, VIVAH_HOME: path.join(work, "home"), ...env }, encoding: "utf8" });

/** A photo-sized JPEG that differs from every other one the bench makes, so duplicate detection keeps all of them. */
function photo(seed, w, h) {
  let s = seed * 2654435761 + 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const [fx, fy, phase] = [1 + rand() * 6, 1 + rand() * 6, rand() * 6.28];
  const data = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = 128 + 90 * Math.sin((x / w) * fx * 6.28 + phase) * Math.cos((y / h) * fy * 6.28) + (rand() - 0.5) * 40;
      const o = (y * w + x) * 4;
      data[o] = Math.max(0, Math.min(255, v + seed * 3));
      data[o + 1] = Math.max(0, Math.min(255, v));
      data[o + 2] = Math.max(0, Math.min(255, v - seed * 2));
    }
  }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 88).data);
}

const results = [];
const record = (area, target, measured, ok, note = "") => results.push({ area, target, measured, ok, note });

// 1. Start to ready: how long the program takes to answer at all.
{
  const times = [];
  for (let i = 0; i < 7; i++) {
    const started = performance.now();
    run(["--help"]);
    times.push(performance.now() - started);
  }
  record("Start to ready (the agent answers `vivah --help`)", "< 3 s", `median ${seconds(median(times))}, p90 ${seconds(percentile(times, 90))}`, percentile(times, 90) < 3000);
}

// 2. First preview of a photo on the local path (decode the embedded picture, shrink to the preview size, re-encode).
const W = EDGE;
const H = Math.round((EDGE * 2) / 3);
const photosDir = path.join(work, "shoot");
mkdirSync(photosDir, { recursive: true });
process.stderr.write(`Making ${PHOTOS} photos of ${W}x${H}…\n`);
for (let i = 0; i < PHOTOS; i++) writeFileSync(path.join(photosDir, `IMG_${String(i).padStart(4, "0")}.jpg`), photo(i + 1, W, H));
{
  const times = [];
  for (let i = 0; i < 8; i++) {
    const started = performance.now();
    await loadPreview({ id: "p", kind: "photo", path: path.join(photosDir, `IMG_${String(i).padStart(4, "0")}.jpg`) });
    times.push(performance.now() - started);
  }
  record("First preview of a photo, local part (cheap-tier model time not included)", "< 15 s p90 including the model", `median ${seconds(median(times))}, p90 ${seconds(percentile(times, 90))} to decode, shrink and encode a ${W}x${H} picture`, percentile(times, 90) < 5000, "the model's own latency is added on top of this");
}

// 3. A batch through the whole pipeline with the mock model: cull, identify, scene, recipe, apply to sidecars.
{
  const refs = path.join(work, "refs");
  mkdirSync(refs);
  writeFileSync(path.join(refs, "r.jpg"), photo(999, 800, 533));
  const profile = path.join(work, "style.json");
  run(["learn", "--refs", refs, "--name", "Bench", "--out", profile, "--provider", "mock"]);
  const started = performance.now();
  const edited = run(["edit", "--folder", photosDir, "--profile", profile, "--provider", "mock", "--db", path.join(work, "jobs.db"), "--job", "bench"]);
  const elapsed = performance.now() - started;
  const summary = /(\d+) ready for review, (\d+) culled, (\d+) failed/.exec(edited.stdout + edited.stderr);
  const ready = Number(summary?.[1] ?? 0);
  const perPhoto = elapsed / Math.max(1, ready + Number(summary?.[2] ?? 0));
  const projected = perPhoto * 500;
  record(
    `Batch of ${PHOTOS} photos through the pipeline (${ready} ready, ${summary?.[2] ?? "?"} culled, ${summary?.[3] ?? "?"} failed)`,
    "500 photos < 10 min p90, without model latency",
    `${seconds(elapsed)} for ${PHOTOS} = ${seconds(perPhoto)} per photo; 500 would take about ${(projected / 60000).toFixed(1)} min`,
    projected < 10 * 60_000 && Number(summary?.[3] ?? 1) === 0,
    "extrapolated linearly; one process, 4 photos at a time",
  );
}

// 4. Idle footprint of the review server holding a 500-photo job.
{
  const code = `
    import { MemoryStore } from "@vivahlens/core";
    import { startReviewServer } from "@vivahlens/review";
    const store = new MemoryStore();
    store.ensureJob({ id: "j", name: "j", adapterId: "fake", styleProfileId: "p", createdAt: "" });
    const assets = Array.from({ length: 500 }, (_, i) => ({ id: "IMG_" + i + ".CR3", kind: "photo", path: "/shoot/IMG_" + i + ".CR3" }));
    for (const a of assets) store.putItem({ jobId: "j", assetId: a.id, state: "review", recipe: { version: "1.0", assetType: "photo", adjustments: { exposure: 0.3, contrast: 5 } }, attempts: 0 });
    const adapter = { id: "fake", capabilities: { mediaKinds: ["photo"], executionModel: "local-cli", requiresGuiOpen: false, os: ["windows"], supportedRecipeFields: ["exposure"] }, detect: async () => ({}), applyRecipe: async (a) => ({ assetId: a.id, outputs: [] }) };
    const started = performance.now();
    const server = await startReviewServer({ store, jobId: "j", assets, adapter, profile: { id: "p", name: "P", version: 1, summary: "", baseAdjustments: {} }, previewOf: async () => ({ mediaType: "image/jpeg", dataBase64: "" }) });
    const ready = performance.now() - started;
    const items = await fetch(server.url.replace("/?t=", "/api/items?t=")).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 1500));
    global.gc();
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 4000));
    const cpu = process.cpuUsage(cpu0);
    const busy = (cpu.user + cpu.system) / 1000 / (performance.now() - t0);
    console.log(JSON.stringify({ rssMb: process.memoryUsage().rss / 1048576, cpuPercent: busy * 100, readyMs: ready, items: items.items.length }));
    await server.close();`;
  const out = await new Promise((resolve, reject) =>
    execFile(process.execPath, ["--expose-gc", "--input-type=module", "-e", code], { cwd: root, encoding: "utf8" }, (err, stdout, stderr) => (err ? reject(new Error(stderr || String(err))) : resolve(stdout))),
  );
  const idle = JSON.parse(out.trim().split("\n").at(-1));
  record(`Review server idle with ${idle.items} photos loaded (the whole Node process)`, "< 150 MB RAM, < 1% CPU", `${idle.rssMb.toFixed(0)} MB resident, ${idle.cpuPercent.toFixed(2)}% of a core; ready in ${idle.readyMs.toFixed(0)} ms`, idle.rssMb < 150 && idle.cpuPercent < 1);
}

console.log(`\nMachine: ${os.cpus().length} x ${os.cpus()[0]?.model.trim()}, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB RAM, ${os.platform()} ${os.release()}, Node ${process.versions.node}\n`);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "MISS"}  ${r.area}\n      target: ${r.target}\n      measured: ${r.measured}${r.note ? `\n      note: ${r.note}` : ""}\n`);
}
console.log("Not measured here: crash-free sessions, 99.9% API availability, cloud render, and the plan's minimum-hardware row. Resumability (kill -9) is tested by packages/core/src/pipeline/resumability.test.ts.");
process.exit(results.every((r) => r.ok) ? 0 : 1);
