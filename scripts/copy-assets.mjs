// Copies the files tsc does not build (the review page's scripts, styles and translations) next to the compiled code.
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = [["packages/review/src/client", "packages/review/dist/client"]];

for (const [from, to] of assets) {
  const source = path.join(root, from);
  const target = path.join(root, to);
  if (!existsSync(source)) throw new Error(`Missing ${from}`);
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true, filter: (file) => !file.endsWith(".test.ts") });
  console.log(`copied ${from} -> ${to}`);
}
