import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { afterAll, describe, expect, it } from "vitest";

// Runs the built program, where the decoders are separate threads; from source there are none to compare against.
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const built = existsSync(main) && existsSync(fileURLToPath(new URL("../../ingest/dist/decodeWorker.js", import.meta.url)));

const root = mkdtempSync(path.join(tmpdir(), "vivah-workers-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function picture(seed: number): Buffer {
  const [w, h] = [320, 213];
  let s = seed * 2654435761 + 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const data = Buffer.alloc(w * h * 4, 255);
  // Distinct from every other picture and full of fine detail, so nothing is culled as blurry or as a duplicate.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.fill(Math.max(0, Math.min(255, 128 + 90 * Math.sin((x / w) * (2 + seed) * 6.28) * Math.cos((y / h) * (3 + seed) * 6.28) + (rand() - 0.5) * 60)), (y * w + x) * 4, (y * w + x) * 4 + 3);
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
}

const run = (home: string, args: string[]) => spawnSync(process.execPath, [main, ...args], { env: { ...process.env, VIVAH_HOME: home }, encoding: "utf8" });

describe.skipIf(!built)("decoding on worker threads, in the built program", () => {
  function shoot(name: string): string {
    const folder = path.join(root, name);
    mkdirSync(folder);
    for (let i = 0; i < 10; i++) writeFileSync(path.join(folder, `IMG_${String(i).padStart(2, "0")}.jpg`), picture(i + 1));
    return folder;
  }

  it("edits exactly as it does without them, and says nothing different", () => {
    const refs = path.join(root, "refs");
    mkdirSync(refs);
    writeFileSync(path.join(refs, "r.jpg"), picture(0));
    const profile = path.join(root, "style.json");
    expect(run(path.join(root, "h0"), ["learn", "--refs", refs, "--name", "S", "--out", profile, "--provider", "mock"]).status).toBe(0);

    const edit = (folder: string, workers: string) => run(path.join(root, `h-${workers}`), ["edit", "--folder", folder, "--profile", profile, "--provider", "mock", "--db", path.join(folder, "..", `jobs-${workers}.db`), "--workers", workers]);
    const pooled = shoot("with-workers");
    const alone = shoot("without-workers");
    const a = edit(pooled, "3");
    const b = edit(alone, "0");
    expect(a.status, a.stderr).toBe(0);
    expect(b.status, b.stderr).toBe(0);
    expect(a.stdout).toContain("10 ready for review, 0 culled, 0 failed");
    // The two runs differ only in the folder (and so job) name.
    expect(a.stdout.replaceAll("with-workers", "JOB")).toBe(b.stdout.replaceAll("without-workers", "JOB"));

    const sidecars = (folder: string) => readdirSync(folder).filter((f) => f.endsWith(".xmp")).sort();
    expect(sidecars(pooled)).toHaveLength(10);
    expect(sidecars(pooled)).toEqual(sidecars(alone));
    for (const name of sidecars(pooled)) expect(readFileSync(path.join(pooled, name), "utf8"), name).toBe(readFileSync(path.join(alone, name), "utf8"));

    // The output cannot tell them apart; the log can, so support can see whether the workers ran.
    const decoder = (workers: string) =>
      readFileSync(path.join(root, `h-${workers}`, "logs", "vivah.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string; mode?: string; workers?: number })
        .find((r) => r.event === "decoder");
    expect(decoder("3")).toMatchObject({ mode: "workers", workers: 3 });
    expect(decoder("0")).toMatchObject({ mode: "in-thread", workers: 0 });
  });

  it("refuses a number of workers that is not a whole number of 0 or more", () => {
    const folder = shoot("bad-workers");
    const profile = path.join(root, "p.json");
    writeFileSync(profile, JSON.stringify({ id: "s", name: "S", version: 1, summary: "", baseAdjustments: {} }));
    for (const bad of ["-1", "two", "1.5"]) {
      const r = run(path.join(root, "hb"), ["edit", "--folder", folder, "--profile", profile, "--provider", "mock", "--db", path.join(root, "bad.db"), "--workers", bad]);
      expect(r.status, bad).toBe(1);
      expect(r.stdout + r.stderr).toContain(`--workers must be a whole number of 0 or more (0 decodes in the main thread), got "${bad}"`);
    }
  });
});
