import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DecodePool, loadAnalysis } from "@vivahlens/ingest";
import { bundle } from "../../../scripts/build-sea.mjs";
import { productionClosure } from "../../../scripts/sbom-closure.mjs";
import { SMOKE_CHECKS, smoke } from "../../../scripts/sea-smoke.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const compiled = path.join(repo, "packages", "cli", "dist", "main.js");
const built = existsSync(compiled) && existsSync(path.join(repo, "packages", "review", "dist", "client", "app.js")) && existsSync(path.join(repo, "packages", "ingest", "dist", "decodeWorker.js"));
const executable = path.join(repo, "dist-sea", process.platform === "win32" ? "vivah.exe" : "vivah");
const scratch = mkdtempSync(path.join(tmpdir(), "vivah-sea-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.skipIf(!built)("the single-file bundle", () => {
  let out: Awaited<ReturnType<typeof bundle>>;
  beforeAll(async () => {
    out = await bundle({ out: path.join(scratch, "bundle") });
  });

  it("runs as one CommonJS file under plain Node, which a top-level await or an ES-module-only construct would prevent", () => {
    const run = spawnSync(process.execPath, [out.main, "--help"], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("vivah: AI editing automation");
    expect(run.stdout).toContain("vivah update");
  });

  it("has no import.meta left in it, since a CommonJS file has none to give: its own path stands in for it", () => {
    for (const file of [out.main, out.worker]) {
      const text = readFileSync(file, "utf8");
      // esbuild turns an import.meta it was not told about into `import_meta`, an empty object, whose url nobody can read.
      expect(text, file).not.toMatch(/import\.meta|\bimport_meta\b/);
    }
    expect(readFileSync(out.main, "utf8")).toContain("__importMetaUrl");
  });

  it("reports the version it was built from, though no package.json sits beside it", () => {
    const report = path.join(scratch, "diagnostics.json");
    const run = spawnSync(process.execPath, [out.main, "diagnostics", "--out", report], { encoding: "utf8", env: { ...process.env, VIVAH_HOME: path.join(scratch, "home") } });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const reported = (JSON.parse(readFileSync(report, "utf8")) as { app: { version: string } }).app.version;
    expect(reported).toBe(out.version);
    expect(reported).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("contains only packages the bill of materials lists", () => {
    const lock = JSON.parse(readFileSync(path.join(repo, "package-lock.json"), "utf8")) as { packages: Record<string, unknown> };
    const listed = [...productionClosure(lock.packages, ["@vivahlens/cli"]).values()];
    const thirdParty = new Set(listed.filter((p) => !p.workspace).map((p) => p.name));
    const own = new Set(listed.filter((p) => p.workspace).map((p) => p.name));
    expect(out.packages.thirdParty.length).toBeGreaterThan(0);
    for (const name of out.packages.thirdParty) expect(thirdParty.has(name), `${name} is bundled but not in the bill of materials`).toBe(true);
    for (const name of out.packages.own) expect(own.has(name), `${name} is bundled but not in the bill of materials`).toBe(true);
    expect(out.packages.own).toContain("@vivahlens/core");
  });

  it("embeds the decoder, every file of the review page and every file of the Lightroom plugin", () => {
    const keys = Object.keys(out.assets);
    expect(keys).toEqual(expect.arrayContaining(["ingest/decodeWorker.cjs", "review/client/app.js", "review/client/app.css", "review/client/locales/en.json", "review/client/locales/hi.json", "lightroom/plugin/Info.lua", "lightroom/plugin/manifest.json"]));
    for (const [key, file] of Object.entries(out.assets)) expect(existsSync(file) && statSync(file).isFile(), key).toBe(true);
    const plugin = path.join(repo, "packages", "lightroom", "plugin", "VivahLens.lrdevplugin");
    expect((JSON.parse(readFileSync(out.assets["lightroom/plugin/manifest.json"], "utf8")) as string[]).sort()).toEqual(readdirSync(plugin).sort());
    expect(keys.filter((k) => k.startsWith("review/client/")).some((k) => k.endsWith(".test.ts"))).toBe(false);
  });

  it("carries a decoder that runs as source code in a worker and decodes exactly as the program does in its own thread", async () => {
    const [w, h] = [200, 133];
    const data = Buffer.alloc(w * h * 4, 255);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.fill((x * 5 + y * 3) % 256, (y * w + x) * 4, (y * w + x) * 4 + 3);
    const file = path.join(scratch, "photo.jpg");
    writeFileSync(file, Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data));
    const photo = { id: "p", kind: "photo" as const, path: file };

    const pool = new DecodePool({ size: 1, workerCode: readFileSync(out.worker, "utf8") });
    try {
      expect(await pool.analysis(photo)).toEqual(await loadAnalysis(photo));
    } finally {
      await pool.close();
    }
  });
});

// The executable itself takes about half a minute to build (`npm run sea`, which runs this same check), so it is checked here
// when a build that is at least as new as the compiled program is lying about, and left to that command otherwise.
const fresh = existsSync(executable) && existsSync(compiled) && statSync(executable).mtimeMs >= statSync(compiled).mtimeMs;

describe.skipIf(!fresh)("the single executable, as built", () => {
  it("does everything the bundle's files are there for, from inside the one file", async () => {
    const version = (JSON.parse(readFileSync(path.join(repo, "packages", "cli", "package.json"), "utf8")) as { version: string }).version;
    const results = await smoke({ command: [executable], version });
    expect(results.map((r) => r.name)).toEqual(SMOKE_CHECKS);
    expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([]);
  }, 180_000);
});
