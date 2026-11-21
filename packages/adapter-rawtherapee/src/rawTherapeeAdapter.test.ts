import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EditRecipe, ProcessRunner } from "@vivahlens/core";
import { compileToPp3 } from "./compile.js";
import { RawTherapeeAdapter } from "./rawTherapeeAdapter.js";

const recipe: EditRecipe = {
  version: "1.0",
  assetType: "photo",
  adjustments: { exposure: 0.5, contrast: 8, whiteBalance: { tempK: 5600, tint: 10 }, noiseReduction: { luminance: 20 }, highlights: -30 },
};

describe("compileToPp3", () => {
  it("emits the mapped sections and skips fields it cannot translate", () => {
    const pp3 = compileToPp3(recipe);
    expect(pp3).toContain("[Exposure]\nCompensation=0.5\nContrast=8");
    expect(pp3).toContain("[White Balance]\nSetting=Custom\nTemperature=5600");
    expect(pp3).toContain("[Directional Pyramid Denoising]\nEnabled=true\nLuma=20");
    expect(pp3).not.toMatch(/highlight/i);
  });
});

describe("RawTherapeeAdapter", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vivah-rt-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const asset = { id: "a", kind: "photo" as const, path: path.join(dir, "IMG_1.NEF") };

  it("writes a sidecar PP3 and exports with -c as the last argument", async () => {
    const calls: (readonly string[])[] = [];
    const run: ProcessRunner = async (_cmd, args) => (calls.push(args), { code: 0, stdout: "", stderr: "" });
    const adapter = new RawTherapeeAdapter({ run });

    const { outputs } = await adapter.applyRecipe(asset, recipe);
    expect(outputs).toEqual([`${asset.path}.pp3`]);
    expect(readFileSync(outputs[0]!, "utf8")).toContain("Compensation=0.5");

    const out = await adapter.export(asset, { format: "jpeg", quality: 90, outputDir: path.join(dir, "out") });
    expect(out.file).toBe(path.join(dir, "out", "IMG_1.jpg"));
    const args = calls[0]!;
    expect(args.at(-2)).toBe("-c");
    expect(args.at(-1)).toBe(asset.path);
    expect(args).toContain("-j90");
    expect(args[args.indexOf("-p") + 1]).toBe(`${asset.path}.pp3`);
  });

  it("surfaces CLI failures and refuses unsupported resize", async () => {
    const adapter = new RawTherapeeAdapter({ run: async () => ({ code: 2, stdout: "", stderr: "bad profile" }) });
    await expect(adapter.export(asset, { format: "jpeg", outputDir: dir })).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED" });
    await expect(adapter.export(asset, { format: "jpeg", maxEdgePx: 2048, outputDir: dir })).rejects.toThrow(/resiz/);
  });

  it("detect returns null when the binary is missing and a version when present", async () => {
    expect(await new RawTherapeeAdapter({ run: async () => ({ code: 1, stdout: "", stderr: "" }) }).detect()).toBeNull();
    const found = await new RawTherapeeAdapter({ run: async () => ({ code: 0, stdout: "RawTherapee, version 5.13", stderr: "" }) }).detect();
    expect(found?.version).toBe("5.13");
  });
});
