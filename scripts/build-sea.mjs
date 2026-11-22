#!/usr/bin/env node
// The single-file program (plan §5, §7j): one executable holding Node, the compiled VivahLens code and the files that ship
// beside it (the review page, the Lightroom plugin, the image decoder), so there is nothing to install but the file itself.
//   npm run build && node scripts/build-sea.mjs [--out dist-sea] [--no-smoke]
// Every step is explained, with its evidence, in docs/research/platform-release-security-verification-3.md §4.
// Verified on Windows x64 with Node 24 (postject). The macOS and Linux steps and the one-step `--build-sea` of Node 25.5+
// follow the same document but have not been run.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, createReadStream, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const PLUGIN_DIR = path.join(root, "packages", "lightroom", "plugin", "VivahLens.lrdevplugin");
const CLIENT_DIR = path.join(root, "packages", "review", "dist", "client");

const posix = (p) => p.split(path.sep).join("/");
const filesUnder = (dir) =>
  readdirSync(dir, { recursive: true })
    .filter((name) => statSync(path.join(dir, name)).isFile())
    .map(posix)
    .sort();

/** The package names behind the files esbuild put in a bundle: third-party ones, and this repository's own. */
function packagesIn(metafile) {
  const thirdParty = new Set();
  const own = new Set();
  for (const input of Object.keys(metafile.inputs).map((i) => i.replaceAll("\\", "/"))) {
    const at = input.lastIndexOf("node_modules/");
    if (at !== -1) {
      const [first, second] = input.slice(at + "node_modules/".length).split("/");
      thirdParty.add(first.startsWith("@") ? `${first}/${second}` : first);
    } else {
      const folder = /^packages\/([^/]+)\//.exec(input)?.[1];
      if (folder) own.add(JSON.parse(readFileSync(path.join(root, "packages", folder, "package.json"), "utf8")).name);
    }
  }
  return { thirdParty: [...thirdParty].sort(), own: [...own].sort() };
}

/**
 * Bundles the program and its image decoder into one CommonJS file each (the single executable can only run CommonJS on Node
 * 22 and 24) and lists every file that goes inside beside them.
 * @returns {Promise<{ main: string, worker: string, assets: Record<string, string>, packages: { thirdParty: string[], own: string[] }, version: string }>}
 */
export async function bundle({ out }) {
  mkdirSync(out, { recursive: true });
  const version = JSON.parse(readFileSync(path.join(root, "packages", "cli", "package.json"), "utf8")).version;
  const shared = {
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    legalComments: "none",
    logLevel: "warning",
    absWorkingDir: root,
    metafile: true,
    // Code locates its neighbours through import.meta.url, which has no meaning in CommonJS: give it the program's own path.
    define: { "import.meta.url": "__importMetaUrl", __VIVAH_VERSION__: JSON.stringify(version) },
    banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  };
  const main = path.join(out, "vivah.cjs");
  const worker = path.join(out, "decodeWorker.cjs");
  const program = await build({ ...shared, entryPoints: ["packages/cli/dist/main.js"], outfile: main });
  const decoder = await build({ ...shared, entryPoints: ["packages/ingest/dist/decodeWorker.js"], outfile: worker });

  const assets = { "ingest/decodeWorker.cjs": worker };
  for (const name of filesUnder(CLIENT_DIR)) assets[`review/client/${name}`] = path.join(CLIENT_DIR, name);
  const pluginFiles = filesUnder(PLUGIN_DIR);
  for (const name of pluginFiles) assets[`lightroom/plugin/${name}`] = path.join(PLUGIN_DIR, name);
  const manifest = path.join(out, "plugin-manifest.json");
  writeFileSync(manifest, JSON.stringify(pluginFiles));
  assets["lightroom/plugin/manifest.json"] = manifest;

  const a = packagesIn(program.metafile);
  const b = packagesIn(decoder.metafile);
  return {
    main,
    worker,
    assets,
    version,
    packages: { thirdParty: [...new Set([...a.thirdParty, ...b.thirdParty])].sort(), own: [...new Set([...a.own, ...b.own])].sort() },
  };
}

function run(command, args, opts = {}) {
  const r = spawnSync(command, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${path.basename(command)} ${args.join(" ")} failed (${r.status ?? r.error?.message}): ${r.stdout ?? ""}${r.stderr ?? ""}`);
  return r;
}

/** Bundles, then injects the result into a copy of this Node. The copy and the blob must come from the same Node version, so both use the one running this script. */
export async function buildExecutable({ out, log = () => undefined }) {
  const { main, assets, version, packages } = await bundle({ out });
  const exe = path.join(out, process.platform === "win32" ? "vivah.exe" : "vivah");
  const blob = path.join(out, "sea-prep.blob");
  const configFile = path.join(out, "sea-config.json");
  const oneStep = process.allowedNodeEnvironmentFlags.has("--build-sea");
  rmSync(exe, { force: true });
  writeFileSync(configFile, JSON.stringify({ main, output: oneStep ? exe : blob, disableExperimentalSEAWarning: true, assets }, null, 2));

  if (oneStep) {
    log(`Building ${path.basename(exe)} with node --build-sea (Node ${process.version})`);
    run(process.execPath, ["--build-sea", configFile], { cwd: out });
  } else {
    log(`Building ${path.basename(exe)} with postject (Node ${process.version})`);
    run(process.execPath, ["--experimental-sea-config", configFile], { cwd: out });
    copyFileSync(process.execPath, exe);
    chmodSync(exe, 0o755);
    // Windows: postject warns that the stock signature "seems corrupted" and the result is unsigned; sign it after injecting.
    if (process.platform === "darwin") run("codesign", ["--remove-signature", exe]);
    const postject = path.join(path.dirname(createRequire(import.meta.url).resolve("postject/package.json")), "dist", "cli.js");
    const inject = [postject, exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", FUSE];
    if (process.platform === "darwin") inject.push("--macho-segment-name", "NODE_SEA");
    run(process.execPath, inject);
    if (process.platform === "darwin") run("codesign", ["--sign", "-", exe]);
  }
  const sha256 = await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(exe).on("data", (d) => hash.update(d)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });
  return { exe, bytes: statSync(exe).size, sha256, version, packages };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { out: { type: "string", default: "dist-sea" }, "no-smoke": { type: "boolean", default: false } } });
  const out = path.resolve(values.out);
  try {
    const built = await buildExecutable({ out, log: (line) => console.log(line) });
    console.log(`Wrote ${built.exe}`);
    console.log(`  ${(built.bytes / 1024 / 1024).toFixed(1)} MB, version ${built.version}, sha256 ${built.sha256}`);
    console.log(`  bundles ${built.packages.thirdParty.join(", ")} and ${built.packages.own.length} VivahLens packages`);
    if (process.platform === "win32") console.log("  Unsigned: sign it after building (signtool sign /fd SHA256 /tr <timestamp server> /td SHA256 <file>).");
    if (!values["no-smoke"]) {
      const { smoke } = await import("./sea-smoke.mjs");
      const results = await smoke({ command: [built.exe], version: built.version, log: (line) => console.log(`  ${line}`) });
      if (results.some((r) => !r.ok)) process.exit(1);
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
