import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import type { ProcessRunner } from "@vivahlens/core";
import { adapterContract } from "@vivahlens/testkit";
import { RawTherapeeAdapter } from "./rawTherapeeAdapter.js";

const dir = mkdtempSync(path.join(tmpdir(), "vivah-rt-contract-"));
const run: ProcessRunner = async () => ({ code: 0, stdout: "RawTherapee, version 5.13", stderr: "" });

adapterContract({
  name: "rawtherapee",
  create: () => ({ adapter: new RawTherapeeAdapter({ run }), cleanup: () => rmSync(dir, { recursive: true, force: true }) }),
  photo: () => ({ id: "a", kind: "photo", path: path.join(dir, "IMG_0001.NEF") }),
  exportSpec: { format: "jpeg", quality: 90, outputDir: path.join(dir, "out") },
  expectApplied: (asset, outputs) => {
    expect(outputs).toEqual([`${asset.path}.pp3`]);
    expect(existsSync(outputs[0]!)).toBe(true);
  },
});
