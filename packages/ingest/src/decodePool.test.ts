import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { afterAll, describe, expect, it } from "vitest";
import type { AssetRef } from "@vivahlens/core";
import { loadAnalysis, loadPreview } from "./images.js";

// The pool runs the compiled worker, as it does for real. From TypeScript source there is no compiled worker, so the pool
// is not used (the agent decodes in its own thread then) and these tests have nothing to start.
const built = existsSync(fileURLToPath(new URL("../dist/decodeWorker.js", import.meta.url)));
const dist = built ? ((await import(/* @vite-ignore */ new URL("../dist/decodePool.js", import.meta.url).href)) as typeof import("./decodePool.js")) : undefined;

const root = mkdtempSync(path.join(tmpdir(), "vivah-pool-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function picture(seed: number, w = 640, h = 427): Buffer {
  const data = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = 128 + 100 * Math.sin((x / w) * (3 + seed) * 6.28) * Math.cos((y / h) * (2 + seed) * 6.28);
      data.fill(Math.max(0, Math.min(255, v + seed * 7)), (y * w + x) * 4, (y * w + x) * 4 + 3);
    }
  }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
}

const asset = (name: string, bytes: Buffer): AssetRef => {
  const file = path.join(root, name);
  writeFileSync(file, bytes);
  return { id: name, kind: "photo", path: file };
};

describe.skipIf(!built)("the decode pool", () => {
  const { DecodePool, defaultDecodeWorkers } = dist!;

  it("gives exactly the answers that decoding in the same thread gives, for the analysis and the preview", async () => {
    const photo = asset("a.jpg", picture(1));
    const pool = new DecodePool({ size: 2 });
    try {
      expect(await pool.analysis(photo)).toEqual(await loadAnalysis(photo));
      expect(await pool.preview(photo)).toEqual(await loadPreview(photo));
      expect(await pool.preview(photo, { maxEdge: 200, quality: 70 })).toEqual(await loadPreview(photo, { maxEdge: 200, quality: 70 }));
    } finally {
      await pool.close();
    }
  });

  it("keeps many photos apart when more are waiting than there are decoders, each answer going to its own photo", async () => {
    const photos = Array.from({ length: 14 }, (_, i) => asset(`p${i}.jpg`, picture(i + 2)));
    const pool = new DecodePool({ size: 3 });
    try {
      const [viaPool, direct] = await Promise.all([Promise.all(photos.map((p) => pool.preview(p))), Promise.all(photos.map((p) => loadPreview(p)))]);
      expect(viaPool).toEqual(direct);
      expect(new Set(viaPool.map((p) => p.dataBase64)).size).toBe(14);
    } finally {
      await pool.close();
    }
  });

  it("fails a photo that cannot be read with the same code as decoding in the same thread, and carries on with the next", async () => {
    const pool = new DecodePool({ size: 1 });
    try {
      const broken = asset("broken.cr3", Buffer.from("not a camera file at all"));
      await expect(pool.preview(broken)).rejects.toMatchObject({ code: "ASSET_UNREADABLE", message: expect.stringContaining("broken.cr3") });
      await expect(loadPreview(broken)).rejects.toMatchObject({ code: "ASSET_UNREADABLE" });
      await expect(pool.analysis({ id: "gone", kind: "photo", path: path.join(root, "never-there.jpg") })).rejects.toMatchObject({ code: expect.any(String) });
      const good = asset("good.jpg", picture(9));
      expect((await pool.preview(good)).mediaType).toBe("image/jpeg");
    } finally {
      await pool.close();
    }
  });

  it("survives a decoder that dies in the middle of a photo: that photo fails, and a fresh decoder takes the next", async () => {
    const flag = path.join(root, "died-once");
    const script = path.join(root, "dies-once.mjs");
    writeFileSync(
      script,
      `import { parentPort } from "node:worker_threads";
       import { existsSync, writeFileSync } from "node:fs";
       parentPort.on("message", (m) => {
         if (!existsSync(${JSON.stringify(flag)})) { writeFileSync(${JSON.stringify(flag)}, "x"); process.exit(3); }
         parentPort.postMessage({ id: m.id, ok: true, result: { survived: m.asset.id } });
       });`,
    );
    const pool = new DecodePool({ size: 1, workerFile: script });
    try {
      const first = pool.preview(asset("first.jpg", picture(1)));
      await expect(first).rejects.toMatchObject({ code: "ASSET_UNREADABLE", message: expect.stringMatching(/image decoder stopped while reading first\.jpg \(exit code 3\)/) });
      await expect(pool.preview(asset("second.jpg", picture(2)))).resolves.toEqual({ survived: "second.jpg" });
    } finally {
      await pool.close();
    }
  });

  it("fails photos waiting behind a dead decoder one at a time, never hanging and never starting without end", async () => {
    const script = path.join(root, "always-dies.mjs");
    writeFileSync(script, `import { parentPort } from "node:worker_threads"; parentPort.on("message", () => process.exit(1));`);
    const pool = new DecodePool({ size: 2, workerFile: script });
    try {
      const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => pool.preview(asset(`d${i}.jpg`, picture(i)))));
      expect(results.every((r) => r.status === "rejected")).toBe(true);
      expect(results.map((r) => (r.status === "rejected" ? (r.reason as { code: string }).code : ""))).toEqual(Array(6).fill("ASSET_UNREADABLE"));
    } finally {
      await pool.close();
    }
  });

  it("starts decoders only as photos need them", async () => {
    const script = path.join(root, "count-starts.mjs");
    const log = path.join(root, "starts.log");
    mkdirSync(path.dirname(log), { recursive: true });
    writeFileSync(
      script,
      `import { parentPort } from "node:worker_threads";
       import { appendFileSync } from "node:fs";
       appendFileSync(${JSON.stringify(log)}, "start\\n");
       parentPort.on("message", (m) => parentPort.postMessage({ id: m.id, ok: true, result: 1 }));`,
    );
    const pool = new DecodePool({ size: 4, workerFile: script });
    try {
      await pool.preview(asset("one.jpg", picture(1)));
      await pool.preview(asset("two.jpg", picture(2)));
      const { readFileSync } = await import("node:fs");
      // Two photos one after the other need one decoder, not four.
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      await pool.close();
    }
  });

  it("stops everything on close: photos waiting fail, later requests fail, and closing twice is harmless", async () => {
    const script = path.join(root, "never-answers.mjs");
    writeFileSync(script, `import { parentPort } from "node:worker_threads"; parentPort.on("message", () => {});`);
    const pool = new DecodePool({ size: 1, workerFile: script });
    // Watch both from the start, so neither rejection is ever unhandled.
    const outcomes = Promise.allSettled([pool.preview(asset("r.jpg", picture(1))), pool.preview(asset("w.jpg", picture(2)))]);
    await new Promise((r) => setTimeout(r, 50));
    await pool.close();
    const [running, waiting] = await outcomes;
    for (const outcome of [running, waiting]) {
      expect(outcome).toMatchObject({ status: "rejected", reason: { code: "ASSET_UNREADABLE", message: "The decoder pool has been closed" } });
    }
    await expect(pool.preview(asset("late.jpg", picture(3)))).rejects.toMatchObject({ message: "The decoder pool has been closed" });
    await expect(pool.close()).resolves.toBeUndefined();
  });

  it("runs a worker given as source code, which is how the single executable carries it", async () => {
    // CommonJS, as the embedded worker is: code evaluated by a worker has no module syntax.
    const code = `const { parentPort } = require("node:worker_threads");
      parentPort.on("message", (m) => parentPort.postMessage({ id: m.id, ok: true, result: { from: "code", asset: m.asset.id } }));`;
    const pool = new DecodePool({ size: 2, workerCode: code });
    try {
      const answers = await Promise.all(["a.jpg", "b.jpg", "c.jpg"].map((name) => pool.preview(asset(name, picture(1)))));
      expect(answers).toEqual([
        { from: "code", asset: "a.jpg" },
        { from: "code", asset: "b.jpg" },
        { from: "code", asset: "c.jpg" },
      ]);
    } finally {
      await pool.close();
    }
  });

  it("chooses a sensible number of decoders by default, and is available only where the compiled worker is", () => {
    expect(defaultDecodeWorkers()).toBeGreaterThanOrEqual(1);
    expect(defaultDecodeWorkers()).toBeLessThanOrEqual(6);
    expect(DecodePool.available()).toBe(true);
  });
});
