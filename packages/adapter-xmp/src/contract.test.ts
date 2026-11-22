import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { adapterContract } from "@vivahlens/testkit";
import { XmpSidecarAdapter } from "./xmpSidecarAdapter.js";

const dir = mkdtempSync(path.join(tmpdir(), "vivah-xmp-contract-"));

adapterContract({
  name: "xmp-sidecar",
  create: () => ({ adapter: new XmpSidecarAdapter({ backupDir: path.join(dir, "backups") }), cleanup: () => rmSync(dir, { recursive: true, force: true }) }),
  asset: () => ({ id: "a", kind: "photo", path: path.join(dir, "IMG_0001.CR3") }),
  expectApplied: (_asset, outputs) => {
    expect(outputs).toEqual([path.join(dir, "IMG_0001.xmp")]);
    expect(readFileSync(outputs[0]!, "utf8")).toContain('crs:Exposure2012="+0.35"');
  },
});
