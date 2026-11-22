#!/usr/bin/env node
// A software bill of materials for what ships (plan §7j, §7k): every package the product needs at run time, in CycloneDX, with
// versions, hashes, licences and package URLs, taken from package-lock.json so it needs no install.
//   node scripts/sbom.mjs [--package <workspace name>]... [--out sbom.cdx.json]
// The default is the command-line product, @vivahlens/cli. The hosted service is its own deliverable:
//   node scripts/sbom.mjs --package @vivahlens/cloud-api --out sbom.cloud-api.cdx.json
//
// What ships is worked out here (sbom-closure.mjs), not by npm's --omit, which gets it wrong in a monorepo. npm still supplies
// each component's metadata. SPDX is not produced: the plan's pipeline attaches CycloneDX.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { productionClosure } from "./sbom-closure.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: { out: { type: "string", default: "sbom.cdx.json" }, package: { type: "string", multiple: true } },
});
const shipped = values.package?.length ? values.package : ["@vivahlens/cli"];

const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};

const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
let closure;
try {
  closure = productionClosure(lock.packages, shipped);
} catch (err) {
  fail(err.message);
}

// One constant command string: Node warns (DEP0190) about an argument list combined with a shell, and on Windows npm is a .cmd file.
const npm = spawnSync("npm sbom --package-lock-only --sbom-format cyclonedx", {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  shell: true,
});
if (npm.status !== 0) fail(`npm sbom failed (is package-lock.json up to date? run npm install). ${npm.stderr.trim()}`);

const bom = JSON.parse(npm.stdout);
const available = bom.components.length;
const kept = bom.components.filter((component) => closure.has(component["bom-ref"]));
const missing = [...closure.keys()].filter((ref) => !kept.some((component) => component["bom-ref"] === ref));
if (missing.length > 0) fail(`package-lock.json lists ${missing.join(", ")} but npm's SBOM does not`);

// npm names a workspace by its folder ("core", "lightroom"); the package's own name is what a scanner or a reader needs.
for (const component of kept) {
  const node = closure.get(component["bom-ref"]);
  if (node.workspace) component.name = node.name;
}

const rootPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const rootRef = bom.metadata.component["bom-ref"];
const shippedRefs = [...closure.values()].filter((node) => node.workspace && shipped.includes(node.name)).map((node) => node.ref);
bom.components = kept;
bom.dependencies = [
  { ref: rootRef, dependsOn: shippedRefs.sort() },
  ...kept.map((component) => ({ ref: component["bom-ref"], dependsOn: [...closure.get(component["bom-ref"]).dependsOn].sort() })),
];
// npm names the root after the folder it ran in, and describes a library; the product is an application.
bom.metadata.component.name = rootPackage.name;
bom.metadata.component.type = "application";

writeFileSync(values.out, `${JSON.stringify(bom, null, 2)}\n`);
const thirdParty = kept.filter((component) => !closure.get(component["bom-ref"]).workspace).length;
console.log(
  `Wrote ${values.out}: ${kept.length} components (${thirdParty} third-party) for ${shipped.join(", ")}; ${available - kept.length} development-only or unshipped left out`,
);
