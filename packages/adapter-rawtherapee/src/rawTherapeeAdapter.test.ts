import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { EditRecipe, ProcessRunner } from "@vivahlens/core";
import { compileToPp3, compileToPp3Detailed, resizeProfile } from "./compile.js";
import { RawTherapeeAdapter } from "./rawTherapeeAdapter.js";

const recipe: EditRecipe = {
  version: "1.0",
  assetType: "photo",
  adjustments: { exposure: 0.5, contrast: 8, whiteBalance: { tempK: 5600, tint: 10 }, noiseReduction: { luminance: 20 }, whites: 20 },
};

/** Stands in for rawtherapee-cli: records the call and writes the output file the way the real tool does. */
const writingRun = (calls?: (readonly string[])[]): ProcessRunner => async (_cmd, args) => {
  calls?.push(args);
  const out = args[args.indexOf("-o") + 1];
  if (out) writeFileSync(out, "jpeg bytes");
  return { code: 0, stdout: "", stderr: "" };
};

describe("compileToPp3", () => {
  it("emits the mapped sections and skips fields it cannot translate", () => {
    const pp3 = compileToPp3(recipe);
    expect(pp3).toContain("[Exposure]\nCompensation=0.5\nContrast=8");
    expect(pp3).toContain("[White Balance]\nEnabled=true\nSetting=Custom\nTemperature=5600");
    expect(pp3).toContain("[Directional Pyramid Denoising]\nEnabled=true\nLuma=20");
    expect(pp3).not.toMatch(/whites|tint/i);
  });

  it("maps shadows and highlights to RawTherapee's one-sided recovery, and says what it cannot do", () => {
    const recovered = compileToPp3Detailed({ ...recipe, adjustments: { highlights: -30, shadows: 20 } });
    expect(recovered.pp3).toContain("[Shadows & Highlights]\nEnabled=true\nHighlights=30\nHighlightTonalWidth=70\nShadows=20\nShadowTonalWidth=30\nRadius=40");
    expect(recovered.warnings).toEqual([]);

    const wrongWay = compileToPp3Detailed({ ...recipe, adjustments: { highlights: 25, shadows: -10 } });
    expect(wrongWay.pp3).not.toContain("Shadows & Highlights");
    expect(wrongWay.warnings).toEqual([expect.stringContaining("only recovers highlights")]);
  });

  it("writes a tone curve as a spline from corner to corner, scaled to 0 to 1, and refuses one that changes nothing", () => {
    const curved = compileToPp3Detailed({ ...recipe, adjustments: { toneCurve: [{ input: 192, output: 204 }, { input: 64, output: 51 }] } });
    expect(curved.pp3).toContain("[Exposure]\nCurveMode=Standard\nCurve=1;0;0;0.25098;0.2;0.752941;0.8;1;1;");
    const flat = compileToPp3Detailed({ ...recipe, adjustments: { toneCurve: [{ input: 0, output: 0 }, { input: 255, output: 255 }] } });
    expect(flat.pp3).not.toContain("Curve=");
    expect(flat.warnings).toEqual([expect.stringContaining("tone curve")]);
  });

  it("maps dehaze, vignette and straightening, and explains the crop it cannot place", () => {
    const out = compileToPp3Detailed({
      ...recipe,
      adjustments: { dehaze: 25, vignette: { amount: -50, feather: 70, roundness: 0 }, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8, rotationDeg: 1.2 } },
    });
    expect(out.pp3).toContain("[Dehaze]\nEnabled=true\nStrength=25");
    expect(out.pp3).toContain("[PCVignette]\nEnabled=true\nStrength=-3\nFeather=70\nRoundness=50");
    expect(out.pp3).toContain("[Rotation]\nDegree=1.2");
    expect(out.warnings).toEqual([expect.stringContaining("straightening angle"), expect.stringContaining("crops in pixels")]);
    expect(compileToPp3Detailed({ ...recipe, adjustments: { dehaze: -20 } }).warnings).toEqual([expect.stringContaining("cannot add haze")]);
  });

  it("puts sharpening on RawTherapee's scale, and turns it off for an amount of zero", () => {
    expect(compileToPp3({ ...recipe, adjustments: { sharpening: { amount: 40, radius: 1 } } })).toContain("[Sharpening]\nEnabled=true\nAmount=200\nRadius=1");
    expect(compileToPp3({ ...recipe, adjustments: { sharpening: { amount: 150 } } })).toContain("Amount=750");
    expect(compileToPp3({ ...recipe, adjustments: { sharpening: { amount: 0, radius: 2 } } })).toBe("[Sharpening]\nEnabled=false\n");
  });

  it("builds a resize profile that scales the long edge and never enlarges", () => {
    expect(resizeProfile(2047.6)).toBe("[Resize]\nEnabled=true\nAppliesTo=Cropped area\nMethod=Lanczos\nDataSpecified=4\nLongEdge=2048\nAllowUpscaling=false\n");
  });
});

describe("RawTherapeeAdapter", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vivah-rt-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const asset = { id: "a", kind: "photo" as const, path: path.join(dir, "IMG_1.NEF") };

  it("writes a sidecar PP3 and exports with -c as the last argument", async () => {
    const calls: (readonly string[])[] = [];
    const adapter = new RawTherapeeAdapter({ run: writingRun(calls) });

    const { outputs } = await adapter.applyRecipe(asset, recipe);
    expect(outputs).toEqual([`${asset.path}.pp3`]);
    expect(readFileSync(outputs[0]!, "utf8")).toContain("Compensation=0.5");

    const out = await adapter.export(asset, { format: "jpeg", quality: 90, outputDir: path.join(dir, "out") });
    expect(out.file).toBe(path.join(dir, "out", "IMG_1.jpg"));
    const args = calls[0]!;
    expect(args.at(-2)).toBe("-c");
    expect(args.at(-1)).toBe(asset.path);
    expect(args).toEqual(expect.arrayContaining(["-q", "-Y", "-j90", "-js3"]));
    expect(args.filter((a) => a === "-p")).toHaveLength(1);
    expect(args[args.indexOf("-p") + 1]).toBe(`${asset.path}.pp3`);
  });

  it("scales the export with a second profile layered over the recipe, and removes it afterwards", async () => {
    let profiles: string[] = [];
    let resize = "";
    const run: ProcessRunner = async (_cmd, args) => {
      profiles = args.flatMap((a, i) => (args[i - 1] === "-p" ? [a] : []));
      resize = readFileSync(profiles[1]!, "utf8"); // it exists only while the tool runs
      writeFileSync(args[args.indexOf("-o") + 1]!, "jpeg");
      return { code: 0, stdout: "", stderr: "" };
    };

    await new RawTherapeeAdapter({ run }).export(asset, { format: "jpeg", maxEdgePx: 2048, outputDir: path.join(dir, "out-resized") });

    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toBe(`${asset.path}.pp3`); // the recipe first, so the size is applied on top of it
    expect(resize).toContain("LongEdge=2048");
    expect(existsSync(profiles[1]!)).toBe(false);
  });

  it("does not pass JPEG options for a TIFF", async () => {
    const calls: (readonly string[])[] = [];
    await new RawTherapeeAdapter({ run: writingRun(calls) }).export(asset, { format: "tiff", outputDir: path.join(dir, "out-tiff") });
    expect(calls[0]).toContain("-t");
    expect(calls[0]!.some((a) => a.startsWith("-j"))).toBe(false);
  });

  it("surfaces CLI failures, and a run that says it succeeded but wrote nothing", async () => {
    const failing = new RawTherapeeAdapter({ run: async () => ({ code: 2, stdout: "", stderr: "bad profile" }) });
    await expect(failing.export(asset, { format: "jpeg", outputDir: dir })).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED", message: expect.stringContaining("bad profile") });

    // A skipped output still exits 0.
    const skipped = new RawTherapeeAdapter({ run: async () => ({ code: 0, stdout: "", stderr: "" }) });
    await expect(skipped.export(asset, { format: "jpeg", outputDir: path.join(dir, "out-skipped") })).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED", message: expect.stringContaining("without writing") });
  });

  it("detect returns null when the binary is missing and a version when present", async () => {
    expect(await new RawTherapeeAdapter({ run: async () => ({ code: 1, stdout: "", stderr: "" }) }).detect()).toBeNull();
    const found = await new RawTherapeeAdapter({ run: async () => ({ code: 0, stdout: "RawTherapee, version 5.13", stderr: "" }) }).detect();
    expect(found?.version).toBe("5.13");
  });
});

describe("RawTherapeeAdapter safety", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vivah-rt-safety-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const outArg = (args: readonly string[]) => args[args.indexOf("-o") + 1]!;

  it("keeps a copy of the photographer's own PP3 before replacing it", async () => {
    const asset = { id: "own", kind: "photo" as const, path: path.join(dir, "IMG_9.NEF") };
    writeFileSync(`${asset.path}.pp3`, "[Exposure]\nCompensation=-1\n");

    const result = await new RawTherapeeAdapter({ backupDir: path.join(dir, "backups") }).applyRecipe(asset, recipe, { jobId: "job-1" });

    expect(readFileSync(`${asset.path}.pp3`, "utf8")).toContain("Compensation=0.5");
    expect(readFileSync(result.replaced![0]!.backup!, "utf8")).toBe("[Exposure]\nCompensation=-1\n");
    const unsafe = await new RawTherapeeAdapter().applyRecipe(asset, recipe);
    expect(unsafe.replaced).toBeUndefined();
    expect(unsafe.warnings).toEqual([expect.stringContaining("cannot be undone")]);
  });

  it("kills the export in flight when the job is cancelled, removes the half-written file, and says it was cancelled", async () => {
    const asset = { id: "slow", kind: "photo" as const, path: path.join(dir, "IMG_10.NEF") };
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const run: ProcessRunner = (_cmd, args, opts) =>
      new Promise((resolve) => {
        writeFileSync(outArg(args), "half a jpeg");
        started();
        opts?.signal?.addEventListener("abort", () => resolve({ code: 1, stdout: "", stderr: "aborted" }), { once: true });
      });
    const adapter = new RawTherapeeAdapter({ run });

    const exporting = adapter.export(asset, { format: "jpeg", outputDir: path.join(dir, "out") }, { jobId: "job-2" });
    await running;
    await adapter.cancel("job-2");

    await expect(exporting).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });
    expect(existsSync(path.join(dir, "out", "IMG_10.jpg"))).toBe(false);
  });

  it("stops an export when the job's own signal fires, and leaves other jobs' exports running", async () => {
    const asset = { id: "s", kind: "photo" as const, path: path.join(dir, "IMG_11.NEF") };
    const finish: (() => void)[] = [];
    const run: ProcessRunner = (_cmd, args, opts) =>
      new Promise((resolve) => {
        writeFileSync(outArg(args), "jpeg");
        finish.push(() => resolve({ code: 0, stdout: "", stderr: "" }));
        opts?.signal?.addEventListener("abort", () => resolve({ code: 1, stdout: "", stderr: "" }), { once: true });
      });
    const adapter = new RawTherapeeAdapter({ run });
    const controller = new AbortController();

    const cancelled = adapter.export(asset, { format: "jpeg", outputDir: path.join(dir, "out2"), fileName: "one" }, { jobId: "A", signal: controller.signal });
    const other = adapter.export(asset, { format: "jpeg", outputDir: path.join(dir, "out2"), fileName: "two" }, { jobId: "B" });
    await vi.waitFor(() => expect(finish).toHaveLength(2), { timeout: 15_000 });
    controller.abort();
    finish[1]!();

    await expect(cancelled).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });
    await expect(other).resolves.toMatchObject({ file: path.join(dir, "out2", "two.jpg") });
    expect(existsSync(path.join(dir, "out2", "one.jpg"))).toBe(false);
  });

  it("removes the partial file when the process fails", async () => {
    const asset = { id: "bad", kind: "photo" as const, path: path.join(dir, "IMG_12.NEF") };
    const run: ProcessRunner = async (_cmd, args) => (writeFileSync(outArg(args), "truncated"), { code: 3, stdout: "", stderr: "disk error" });

    await expect(new RawTherapeeAdapter({ run }).export(asset, { format: "jpeg", outputDir: path.join(dir, "out3") })).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED" });
    expect(existsSync(path.join(dir, "out3", "IMG_12.jpg"))).toBe(false);
  });

  it("shows the PP3 a recipe would produce without writing it", () => {
    const native = new RawTherapeeAdapter().translateRecipe(recipe);
    expect(native).toMatchObject({ kind: "pp3", unsupported: ["whites"] });
    expect(native.payload).toContain("Compensation=0.5");
  });
});
