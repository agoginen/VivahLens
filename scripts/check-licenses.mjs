// Third-party licence gate (plan §7k): every *runtime* dependency of every workspace package must carry a
// permissive licence, and NOTICE must list them. Dev-only tooling (typescript, vitest, …) is not shipped, so it is skipped.
//
//   node scripts/check-licenses.mjs           check (CI)
//   node scripts/check-licenses.mjs --write   regenerate NOTICE
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0", "CC0-1.0"]);

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

function workspacePackages() {
  const rootPkg = readJson(path.join(root, "package.json"));
  const dirs = (rootPkg.workspaces ?? []).flatMap((glob) => {
    if (!glob.endsWith("/*")) return [glob];
    const base = path.join(root, glob.slice(0, -2));
    return readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(glob.slice(0, -2), e.name));
  });
  return dirs.map((d) => readJson(path.join(root, d, "package.json")));
}

function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return "UNKNOWN";
}

/** SPDX expression check: `A OR B` needs one allowed side; `A AND B` needs both. */
function allowed(expression) {
  const cleaned = expression.replace(/[()]/g, " ").trim();
  if (/\sAND\s/.test(cleaned)) return cleaned.split(/\s+AND\s+/).every((p) => allowed(p));
  return cleaned.split(/\s+OR\s+/).some((p) => ALLOWED.has(p.trim()));
}

function licenseText(dir) {
  const name = readdirSync(dir).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
  return name ? readFileSync(path.join(dir, name), "utf8").trim() : undefined;
}

function collect() {
  const workspaceNames = new Set(workspacePackages().map((p) => p.name));
  const found = new Map();
  const visit = (name) => {
    if (found.has(name) || workspaceNames.has(name)) return;
    const dir = path.join(root, "node_modules", name);
    if (!existsSync(path.join(dir, "package.json"))) throw new Error(`Dependency "${name}" is not installed; run npm install`);
    const pkg = readJson(path.join(dir, "package.json"));
    found.set(name, { name, version: pkg.version, license: licenseOf(pkg), text: licenseText(dir), url: pkg.homepage ?? pkg.repository?.url ?? "" });
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep);
  };
  for (const pkg of workspacePackages()) for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function notice(deps) {
  const header = `VivahLens third-party notices\n\nThis product bundles the following open-source packages. Regenerate with:\n  node scripts/check-licenses.mjs --write\n`;
  const body = deps
    .map((d) => `\n${"=".repeat(72)}\n${d.name}@${d.version}  (${d.license})\n${d.url}\n\n${d.text ?? "(no licence file shipped with the package)"}\n`)
    .join("");
  return `${header}${body}`;
}

const deps = collect();
const bad = deps.filter((d) => !allowed(d.license));
console.log("Runtime dependencies:");
for (const d of deps) console.log(`  ${allowed(d.license) ? "ok " : "BAD"} ${d.name}@${d.version}  ${d.license}`);

if (bad.length) {
  console.error(`\nDisallowed or unknown licences: ${bad.map((d) => `${d.name} (${d.license})`).join(", ")}`);
  process.exit(1);
}

const noticePath = path.join(root, "NOTICE");
const expected = notice(deps);
// Checkouts may convert line endings (core.autocrlf on Windows), so compare on normalized newlines.
const normalize = (text) => text.replace(/\r\n/g, "\n");
if (process.argv.includes("--write")) {
  writeFileSync(noticePath, expected, "utf8");
  console.log(`\nwrote ${noticePath}`);
} else if (!existsSync(noticePath) || normalize(readFileSync(noticePath, "utf8")) !== normalize(expected)) {
  console.error("\nNOTICE is missing or out of date. Run: node scripts/check-licenses.mjs --write");
  process.exit(1);
} else {
  console.log("\nNOTICE is up to date.");
}
