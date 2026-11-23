// What a built program must be able to do, checked by running it: not just start, but use every file that was put inside it
// for the single-file build (the review page, the Lightroom plugin, the image decoder). Used by scripts/build-sea.mjs and by
// the test that guards the build. `command` is the program and any leading arguments, e.g. ["dist-sea/vivah.exe"] or
// [process.execPath, "packages/cli/dist/main.js"].
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_SOURCE = path.join(root, "packages", "lightroom", "plugin", "VivahLens.lrdevplugin");

/** The names of the checks, in the order they run. */
export const SMOKE_CHECKS = ["starts and prints its usage", "knows its own version", "edits photos on decoder workers", "serves the review page and every file it uses", "installs the Lightroom plugin", "leaves nothing behind in the temp folder"];

function picture(seed) {
  const [w, h] = [320, 213];
  let s = seed * 2654435761 + 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const data = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = 128 + 90 * Math.sin((x / w) * (2 + seed) * 6.28) * Math.cos((y / h) * (3 + seed) * 6.28) + (rand() - 0.5) * 60;
      data.fill(Math.max(0, Math.min(255, v)), (y * w + x) * 4, (y * w + x) * 4 + 3);
    }
  }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
}

const leftovers = () => readdirSync(os.tmpdir()).filter((name) => name.startsWith("vivahlens-plugin-")).sort();

/**
 * @param {{ command: string[], version?: string, log?: (line: string) => void }} opts
 * @returns {Promise<{ name: string, ok: boolean, detail: string }[]>} one result per check; a failed check does not stop the rest
 */
export async function smoke({ command, version, log = () => undefined }) {
  const work = mkdtempSync(path.join(os.tmpdir(), "vivah-smoke-"));
  const home = path.join(work, "home");
  const appdata = path.join(work, "appdata");
  mkdirSync(home);
  // Everything the program writes goes under `work`: its own data, and the folders the editors would be installed to.
  const env = { ...process.env, VIVAH_HOME: home, APPDATA: appdata, HOME: work, USERPROFILE: work, VIVAH_LOG_LEVEL: "info" };
  const run = (args) => spawnSync(command[0], [...command.slice(1), ...args], { env, encoding: "utf8", timeout: 120_000 });
  const results = [];
  const check = async (name, body) => {
    try {
      const detail = await body();
      results.push({ name, ok: true, detail: detail ?? "" });
    } catch (err) {
      results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
    const last = results.at(-1);
    log(`${last.ok ? "ok  " : "FAIL"} ${name}${last.detail ? ` (${last.detail})` : ""}`);
  };
  const must = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  const before = leftovers();
  const shoot = path.join(work, "shoot");
  const refs = path.join(work, "refs");
  mkdirSync(shoot);
  mkdirSync(refs);
  for (let i = 0; i < 6; i++) writeFileSync(path.join(shoot, `IMG_${i}.jpg`), picture(i + 1));
  writeFileSync(path.join(refs, "r.jpg"), picture(0));
  const profile = path.join(work, "style.json");

  try {
    await check(SMOKE_CHECKS[0], () => {
      const started = performance.now();
      const r = run(["--help"]);
      const ms = Math.round(performance.now() - started);
      must(r.status === 0, `exit ${r.status}: ${r.stderr}`);
      must(r.stdout.includes("vivah: AI editing automation"), "the usage text is missing");
      must(ms < 10_000, `took ${ms} ms`);
      return `${ms} ms`;
    });

    await check(SMOKE_CHECKS[1], () => {
      const out = path.join(work, "diagnostics.json");
      const r = run(["diagnostics", "--out", out]);
      must(r.status === 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);
      const reported = JSON.parse(readFileSync(out, "utf8")).app?.version;
      must(reported !== undefined && reported !== "unknown", `the version is ${reported}`);
      must(version === undefined || reported === version, `reports ${reported}, expected ${version}`);
      return reported;
    });

    await check(SMOKE_CHECKS[2], () => {
      const learned = run(["learn", "--refs", refs, "--name", "Smoke", "--out", profile, "--provider", "mock"]);
      must(learned.status === 0, `learn: exit ${learned.status}: ${learned.stdout}${learned.stderr}`);
      const edited = run(["edit", "--folder", shoot, "--profile", profile, "--provider", "mock", "--workers", "2"]);
      must(edited.status === 0, `edit: exit ${edited.status}: ${edited.stdout}${edited.stderr}`);
      must(edited.stdout.includes("6 ready for review, 0 culled, 0 failed"), `unexpected summary: ${edited.stdout}`);
      must(readdirSync(shoot).filter((f) => f.endsWith(".xmp")).length === 6, "expected six sidecars");
      const decoder = readFileSync(path.join(home, "logs", "vivah.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((record) => record.event === "decoder");
      must(decoder?.mode === "workers" && decoder.workers === 2, `decoding did not use the workers: ${JSON.stringify(decoder)}`);
    });

    await check(SMOKE_CHECKS[3], async () => {
      const child = spawn(command[0], [...command.slice(1), "review", "--folder", shoot, "--profile", profile, "--provider", "mock", "--no-open"], { env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      const exited = new Promise((resolve) => child.once("exit", resolve));
      try {
        const url = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no address after 30 s: ${output}`)), 30_000);
          const look = () => {
            const found = /Review UI \(local only\): (http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+)/.exec(output);
            if (found) {
              clearTimeout(timer);
              resolve(found[1]);
            }
          };
          child.stdout.on("data", look);
          child.once("exit", (code) => reject(new Error(`exited with ${code}: ${output}`)));
        });
        const page = await fetch(url);
        const html = await page.text();
        must(page.status === 200 && html.includes("<html"), `the page answered ${page.status}`);
        // Every file the page names, the modules those import (as the browser follows them), and the translations it loads at start.
        const queue = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))];
        for (const translation of ["/assets/locales/en.json", "/assets/locales/hi.json"]) if (!queue.includes(translation)) queue.push(translation);
        for (let i = 0; i < queue.length; i++) {
          const file = queue[i];
          const r = await fetch(new URL(file, url));
          const body = await r.text();
          must(r.status === 200 && body.length > 0, `${file} answered ${r.status}`);
          if (file.endsWith(".json")) JSON.parse(body);
          if (file.endsWith(".js")) {
            for (const m of body.matchAll(/(?:from|import)\s*\(?\s*["'](\.\/[^"']+)["']/g)) {
              const next = new URL(m[1], new URL(file, url)).pathname;
              if (!queue.includes(next)) queue.push(next);
            }
          }
        }
        return `${queue.length} files`;
      } finally {
        child.kill();
        await exited;
      }
    });

    await check(SMOKE_CHECKS[4], () => {
      const r = run(["plugin", "lightroom"]);
      if (process.platform !== "win32" && process.platform !== "darwin") {
        must(r.status !== 0 && /Windows and macOS only/.test(r.stdout + r.stderr), "expected the refusal on this system");
        return "not applicable on this system";
      }
      must(r.status === 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);
      const modules = process.platform === "win32" ? path.join(appdata, "Adobe", "Lightroom", "Modules") : path.join(work, "Library", "Application Support", "Adobe", "Lightroom", "Modules");
      const installed = path.join(modules, "VivahLens.lrdevplugin");
      const shipped = readdirSync(PLUGIN_SOURCE).sort();
      must(JSON.stringify(readdirSync(installed).sort()) === JSON.stringify(shipped), "the installed files differ from the plugin's");
      for (const name of shipped) must(readFileSync(path.join(installed, name)).equals(readFileSync(path.join(PLUGIN_SOURCE, name))), `${name} differs`);
      return `${shipped.length} files`;
    });

    await check(SMOKE_CHECKS[5], () => {
      must(JSON.stringify(leftovers()) === JSON.stringify(before), `left behind: ${leftovers().filter((n) => !before.includes(n)).join(", ")}`);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
    for (const name of leftovers().filter((n) => !before.includes(n))) rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv.slice(2);
  if (command.length === 0 || !existsSync(command[0])) {
    console.error("usage: node scripts/sea-smoke.mjs <program> [leading arguments...]");
    process.exit(2);
  }
  const results = await smoke({ command, log: (line) => console.log(line) });
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
