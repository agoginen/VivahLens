import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import type { ProcessRunner } from "@vivahlens/core";
import { adapterContract } from "@vivahlens/testkit";
import { DarktableAdapter } from "./darktableAdapter.js";

const dir = mkdtempSync(path.join(tmpdir(), "vivah-dt-contract-"));
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "IMG_0001.NEF"), "raw bytes");
/** Answers `--version`, and writes a JPEG where an export was asked to, as darktable-cli does. */
const run: ProcessRunner = async (_command, args) => {
  if (args[0] === "--version") return { code: 0, stdout: "this is darktable 5.6.2", stderr: "" };
  const out = args[args.indexOf("--out-ext") - 1]!;
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
  return { code: 0, stdout: "", stderr: "" };
};

adapterContract({
  name: "darktable",
  create: () => ({ adapter: new DarktableAdapter({ run, backupDir: path.join(dir, "backups"), configDir: path.join(dir, "conf") }), cleanup: () => rmSync(dir, { recursive: true, force: true }) }),
  asset: () => ({ id: "a", kind: "photo", path: path.join(dir, "IMG_0001.NEF") }),
  recipes: {
    // The contract's default sample has no crop, so a darktable sidecar would be empty; give it something darktable can be given.
    sample: { version: "1.0", assetType: "photo", adjustments: { exposure: 0.35, contrast: -8, crop: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 } } },
  },
  exportSpec: { format: "jpeg", quality: 90, outputDir: path.join(dir, "out") },
  expectApplied: (asset, outputs) => {
    expect(outputs).toEqual([`${asset.path}.xmp`]);
    expect(existsSync(outputs[0]!)).toBe(true);
    expect(readFileSync(outputs[0]!, "utf8")).toContain('darktable:operation="exposure"');
  },
});
