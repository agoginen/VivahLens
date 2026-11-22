import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import type { ProcessRunner } from "@vivahlens/core";
import { adapterContract } from "@vivahlens/testkit";
import { RawTherapeeAdapter } from "./rawTherapeeAdapter.js";

const dir = mkdtempSync(path.join(tmpdir(), "vivah-rt-contract-"));
/** Answers `-v` with a version and writes the output file when asked to export, as rawtherapee-cli does. */
const run: ProcessRunner = async (_cmd, args) => {
  const out = args[args.indexOf("-o") + 1];
  if (args.includes("-o") && out) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, "jpeg bytes");
  }
  return { code: 0, stdout: "RawTherapee, version 5.13", stderr: "" };
};

adapterContract({
  name: "rawtherapee",
  create: () => ({ adapter: new RawTherapeeAdapter({ run, backupDir: path.join(dir, "backups") }), cleanup: () => rmSync(dir, { recursive: true, force: true }) }),
  asset: () => ({ id: "a", kind: "photo", path: path.join(dir, "IMG_0001.NEF") }),
  exportSpec: { format: "jpeg", quality: 90, outputDir: path.join(dir, "out") },
  expectApplied: (asset, outputs) => {
    expect(outputs).toEqual([`${asset.path}.pp3`]);
    expect(existsSync(outputs[0]!)).toBe(true);
  },
});
