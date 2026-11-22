import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AssetRef, EditRecipe, ProcessRunner } from "@vivahlens/core";
import { DarktableAdapter, sidecarPath } from "./darktableAdapter.js";
import { readExposure } from "./params.js";

const root = mkdtempSync(path.join(tmpdir(), "vivah-dt-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function workspace() {
  const dir = path.join(root, `w${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const raw = (dir: string, name = "IMG_0412.CR3"): AssetRef => {
  const file = path.join(dir, name);
  writeFileSync(file, "raw bytes");
  return { id: name, kind: "photo", path: file };
};
const recipe = (adjustments: EditRecipe["adjustments"]): EditRecipe => ({ version: "1.0", assetType: "photo", adjustments });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const TIFF = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);

/** Behaves like darktable-cli as far as the research reads it: `--version` exits 0, an export writes the file named before `--out-ext`. */
function fakeDarktable(opts: { version?: string; exit?: number; stderr?: string; write?: Buffer | false; exportMs?: number } = {}) {
  const calls: { command: string; args: string[] }[] = [];
  let active = 0;
  let overlapped = false;
  const run: ProcessRunner = async (command, args, o) => {
    calls.push({ command, args: [...args] });
    if (args[0] === "--version") return { code: 0, stdout: `this is darktable ${opts.version ?? "5.6.2"}\ncopyright (c) 2009-2026\n`, stderr: "" };
    if (active > 0) overlapped = true;
    active++;
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, opts.exportMs ?? 5);
        o?.signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
      });
      if (o?.signal?.aborted) return { code: -1, stdout: "", stderr: "killed" };
      const out = args[args.indexOf("--out-ext") - 1]!;
      if (opts.write !== false && (opts.exit ?? 0) === 0) writeFileSync(out, opts.write ?? (args[args.indexOf("--out-ext") + 1] === "tif" ? TIFF : JPEG));
      return { code: opts.exit ?? 0, stdout: "", stderr: opts.stderr ?? "" };
    } finally {
      active--;
    }
  };
  return { run, calls, overlapped: () => overlapped };
}

const exposureOf = (sidecar: string) => {
  const hex = /darktable:operation="exposure"[^>]*darktable:params="([0-9a-f]+)"/.exec(sidecar)?.[1];
  return hex ? readExposure(hex)!.exposure : undefined;
};

describe("finding darktable", () => {
  it("reads the version from darktable-cli --version", async () => {
    const f = fakeDarktable({ version: "5.6.2" });
    expect(await new DarktableAdapter({ run: f.run }).detect()).toEqual({ path: "darktable-cli", version: "5.6.2" });
    expect(f.calls[0]).toEqual({ command: "darktable-cli", args: ["--version"] });
    expect(await new DarktableAdapter({ run: fakeDarktable({ version: "5.8" }).run, binary: "C:\\Program Files\\darktable\\bin\\darktable-cli.exe" }).detect()).toEqual({ path: "C:\\Program Files\\darktable\\bin\\darktable-cli.exe", version: "5.8" });
  });

  it("is absent when the program does not run", async () => {
    expect(await new DarktableAdapter({ run: async () => ({ code: 127, stdout: "", stderr: "not found" }) }).detect()).toBeNull();
  });
});

describe("applying a recipe", () => {
  it("writes a darktable sidecar next to the raw file, named the way darktable names it", async () => {
    const dir = workspace();
    const asset = raw(dir);
    const adapter = new DarktableAdapter({ run: fakeDarktable().run });
    const result = await adapter.applyRecipe(asset, recipe({ exposure: 0.35, crop: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 } }));
    expect(sidecarPath(asset.path)).toBe(`${asset.path}.xmp`);
    expect(path.basename(sidecarPath(asset.path))).toBe("IMG_0412.CR3.xmp");
    expect(result).toMatchObject({ assetId: asset.id, outputs: [sidecarPath(asset.path)] });
    const xml = readFileSync(sidecarPath(asset.path), "utf8");
    expect(exposureOf(xml)).toBeCloseTo(1.05, 5);
    expect(xml).toContain('darktable:operation="crop"');
    expect(xml).toContain('darktable:history_end="2"');
  });

  it("merges into the photographer's own sidecar, keeping a copy so it can be undone", async () => {
    const dir = workspace();
    const asset = raw(dir);
    const own = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:darktable="http://darktable.sf.net/" xmp:Rating="5" darktable:xmp_version="5" darktable:history_end="0" darktable:iop_order_version="4"><darktable:history><rdf:Seq/></darktable:history></rdf:Description></rdf:RDF></x:xmpmeta>`;
    writeFileSync(sidecarPath(asset.path), own);
    const adapter = new DarktableAdapter({ run: fakeDarktable().run, backupDir: path.join(dir, "backups") });
    const result = await adapter.applyRecipe(asset, recipe({ exposure: 0.35 }), { jobId: "job1" });
    expect(readFileSync(sidecarPath(asset.path), "utf8")).toContain('xmp:Rating="5"');
    expect(exposureOf(readFileSync(sidecarPath(asset.path), "utf8"))).toBeCloseTo(1.05, 5);
    expect(result.replaced).toHaveLength(1);
    expect(readFileSync(result.replaced![0]!.backup!, "utf8")).toBe(own);
  });

  it("says so when it cannot keep a copy of a sidecar it changed", async () => {
    const dir = workspace();
    const asset = raw(dir);
    const adapter = new DarktableAdapter({ run: fakeDarktable().run });
    await adapter.applyRecipe(asset, recipe({ exposure: 0.1 }));
    const second = await adapter.applyRecipe(asset, recipe({ exposure: 0.5 }));
    expect(second.warnings).toEqual(["IMG_0412.CR3.xmp already existed and no backup folder is configured, so this change cannot be undone"]);
    expect(second.replaced).toBeUndefined();
  });

  it("applies the same recipe twice without growing the history", async () => {
    const dir = workspace();
    const asset = raw(dir);
    const adapter = new DarktableAdapter({ run: fakeDarktable().run, backupDir: path.join(dir, "b") });
    await adapter.applyRecipe(asset, recipe({ exposure: 0.35 }));
    const once = readFileSync(sidecarPath(asset.path), "utf8");
    await adapter.applyRecipe(asset, recipe({ exposure: 0.35 }));
    expect(readFileSync(sidecarPath(asset.path), "utf8")).toBe(once);
  });

  it("leaves the photo alone, and writes no file, when nothing in the recipe is something darktable can be given", async () => {
    const dir = workspace();
    const asset = raw(dir);
    const adapter = new DarktableAdapter({ run: fakeDarktable().run });
    const result = await adapter.applyRecipe(asset, recipe({ contrast: 20, whiteBalance: { tempK: 5000 } }));
    expect(result).toEqual({ assetId: asset.id, outputs: [] });
    expect(existsSync(sidecarPath(asset.path))).toBe(false);
  });

  it("reports what it could not honour", async () => {
    const dir = workspace();
    const asset = raw(dir);
    const result = await new DarktableAdapter({ run: fakeDarktable().run }).applyRecipe(asset, recipe({ crop: { x: 0.1, width: 0.5, rotationDeg: 2 } }));
    expect(result.warnings).toEqual(["Straightening by 2° was not applied: darktable's crop module cannot rotate"]);
  });

  it("refuses a file that is not a raw file, a video, a sidecar that is not darktable's, and a cancelled job, without touching anything", async () => {
    const dir = workspace();
    const adapter = new DarktableAdapter({ run: fakeDarktable().run });
    const jpeg = raw(dir, "IMG_1.JPG");
    await expect(adapter.applyRecipe(jpeg, recipe({ exposure: 1 }))).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED", message: "IMG_1.JPG is not a raw file; the darktable adapter writes darktable's raw-file sidecars" });
    await expect(adapter.applyRecipe({ id: "v", kind: "video", path: path.join(dir, "clip.mov") }, recipe({ exposure: 1 }))).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED" });

    const asset = raw(dir);
    const lightroom = `<x:xmpmeta><rdf:RDF><rdf:Description crs:Exposure2012="+1.0"/></rdf:RDF></x:xmpmeta>`;
    writeFileSync(sidecarPath(asset.path), lightroom);
    await expect(adapter.applyRecipe(asset, recipe({ exposure: 1 }))).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED", message: expect.stringContaining("is not a darktable sidecar") });
    expect(readFileSync(sidecarPath(asset.path), "utf8")).toBe(lightroom);

    const controller = new AbortController();
    controller.abort();
    await expect(adapter.applyRecipe(raw(dir, "IMG_2.NEF"), recipe({ exposure: 1 }), { signal: controller.signal })).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });
  });

  it("refuses an installed darktable older than the one whose parameter layouts it writes, but not one it has not asked", async () => {
    const dir = workspace();
    const asset = raw(dir);
    const undetected = new DarktableAdapter({ run: fakeDarktable({ version: "4.8.1" }).run });
    await expect(undetected.applyRecipe(asset, recipe({ exposure: 0.2 }))).resolves.toMatchObject({ outputs: [sidecarPath(asset.path)] });
    rmSync(sidecarPath(asset.path));

    for (const [version, fine] of [["4.8.1", false], ["5.0.0", false], ["5.4.1", false], ["5.6.0", true], ["5.6.2", true], ["5.8.0", true], ["6.0.1", true]] as const) {
      const adapter = new DarktableAdapter({ run: fakeDarktable({ version }).run });
      await adapter.detect();
      const outcome = adapter.applyRecipe(asset, recipe({ exposure: 0.2 }));
      if (fine) await expect(outcome, version).resolves.toBeDefined();
      else await expect(outcome, version).rejects.toMatchObject({ code: "ADAPTER_VERSION_UNSUPPORTED", message: expect.stringContaining(`darktable ${version} is older than 5.6`) });
      rmSync(sidecarPath(asset.path), { force: true });
    }
  });

  it("shows the sidecar a recipe turns into without writing it, and what it ignores", () => {
    const adapter = new DarktableAdapter({ run: fakeDarktable().run });
    const native = adapter.translateRecipe(recipe({ exposure: 0.35, contrast: 10 }), { id: "a", kind: "photo", path: "D:\\shoot\\IMG_9.CR3" });
    expect(native.kind).toBe("darktable-xmp");
    expect(native.unsupported).toEqual(["contrast"]);
    expect(String(native.payload)).toContain('xmpMM:DerivedFrom="IMG_9.CR3"');
    expect(exposureOf(String(native.payload))).toBeCloseTo(1.05, 5);
  });
});

describe("exporting", () => {
  const spec = (dir: string, more: object = {}) => ({ format: "jpeg" as const, quality: 90, outputDir: path.join(dir, "out"), ...more });

  it("runs darktable-cli on the raw file with its sidecar, into a private settings folder, forcing overwrite, with the quality asked for", async () => {
    const dir = workspace();
    const asset = raw(dir);
    const f = fakeDarktable();
    const adapter = new DarktableAdapter({ run: f.run, configDir: path.join(dir, "dtconf") });
    await adapter.applyRecipe(asset, recipe({ exposure: 0.35 }));
    const out = await adapter.export(asset, spec(dir, { fileName: "IMG_0412" }));
    expect(out).toEqual({ assetId: asset.id, file: path.join(dir, "out", "IMG_0412.jpg") });
    expect(readFileSync(out.file).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(f.calls.at(-1)).toEqual({
      command: "darktable-cli",
      args: [asset.path, sidecarPath(asset.path), out.file, "--out-ext", "jpg", "--hq", "true", "--apply-custom-presets", "false", "--core", "--configdir", path.join(dir, "dtconf"), "--conf", "plugins/imageio/format/jpeg/quality=90", "--conf", "plugins/imageio/storage/disk/overwrite=1"],
    });
    expect(existsSync(path.join(dir, "dtconf"))).toBe(true);
  });

  it("limits the long edge with darktable's maximum width and height, which never enlarge, and writes a 16-bit TIFF when asked", async () => {
    const dir = workspace();
    const asset = raw(dir);
    const f = fakeDarktable();
    const adapter = new DarktableAdapter({ run: f.run, configDir: path.join(dir, "c") });
    await adapter.export(asset, spec(dir, { maxEdgePx: 2048 }));
    expect(f.calls.at(-1)!.args.slice(f.calls.at(-1)!.args.indexOf("--hq"))).toEqual(["--hq", "true", "--apply-custom-presets", "false", "--width", "2048", "--height", "2048", "--core", "--configdir", path.join(dir, "c"), "--conf", "plugins/imageio/format/jpeg/quality=90", "--conf", "plugins/imageio/storage/disk/overwrite=1"]);
    const tiff = await adapter.export(asset, { format: "tiff", outputDir: path.join(dir, "out") });
    expect(path.extname(tiff.file)).toBe(".tif");
    expect(f.calls.at(-1)!.args).toContain("plugins/imageio/format/tiff/bpp=16");
    expect(f.calls.at(-1)!.args).toContain("tif");
  });

  it("keeps the quality inside what darktable accepts", async () => {
    const dir = workspace();
    const asset = raw(dir);
    const f = fakeDarktable();
    const adapter = new DarktableAdapter({ run: f.run, configDir: path.join(dir, "c") });
    for (const [asked, sent] of [[1, 5], [150, 100], [92.6, 93]] as const) {
      await adapter.export(asset, spec(dir, { quality: asked }));
      expect(f.calls.at(-1)!.args).toContain(`plugins/imageio/format/jpeg/quality=${sent}`);
    }
  });

  it("exports with darktable's defaults, and no sidecar argument, for a photo it had nothing to apply to", async () => {
    const dir = workspace();
    const asset = raw(dir);
    const f = fakeDarktable();
    await new DarktableAdapter({ run: f.run, configDir: path.join(dir, "c") }).export(asset, spec(dir));
    const args = f.calls.at(-1)!.args;
    expect(args.slice(0, 2)).toEqual([asset.path, path.join(dir, "out", "IMG_0412.jpg")]);
    expect(args).not.toContain(sidecarPath(asset.path));
  });

  it("clears an old file of that name first, so a stale one is never taken for this export", async () => {
    const dir = workspace();
    const asset = raw(dir);
    mkdirSync(path.join(dir, "out"), { recursive: true });
    writeFileSync(path.join(dir, "out", "IMG_0412.jpg"), JPEG);
    const skipped = fakeDarktable({ write: false });
    await expect(new DarktableAdapter({ run: skipped.run, configDir: path.join(dir, "c") }).export(asset, spec(dir))).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED", message: "darktable-cli finished without writing a usable IMG_0412.jpg" });
    expect(existsSync(path.join(dir, "out", "IMG_0412.jpg"))).toBe(false);
  });

  it("fails clearly when darktable-cli fails, when it writes something that is not an image, and leaves nothing behind", async () => {
    const dir = workspace();
    const asset = raw(dir);
    const failing = fakeDarktable({ exit: 1, stderr: "error: can't open XMP file ‘x’" });
    await expect(new DarktableAdapter({ run: failing.run, configDir: path.join(dir, "c") }).export(asset, spec(dir))).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED", message: expect.stringContaining("darktable-cli exited with 1: error: can't open XMP file") });
    const junk = fakeDarktable({ write: Buffer.from("<html>") });
    await expect(new DarktableAdapter({ run: junk.run, configDir: path.join(dir, "c") }).export(asset, spec(dir))).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED" });
    expect(existsSync(path.join(dir, "out", "IMG_0412.jpg"))).toBe(false);
    const wrongKind = fakeDarktable({ write: TIFF });
    await expect(new DarktableAdapter({ run: wrongKind.run, configDir: path.join(dir, "c") }).export(asset, spec(dir))).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED" });
  });

  it("runs one export at a time, in order, even when asked for several at once", async () => {
    const dir = workspace();
    const a = raw(dir, "IMG_1.CR3");
    const b = raw(dir, "IMG_2.CR3");
    const c = raw(dir, "IMG_3.CR3");
    const f = fakeDarktable({ exportMs: 15 });
    const adapter = new DarktableAdapter({ run: f.run, configDir: path.join(dir, "c") });
    const done = await Promise.all([a, b, c].map((asset) => adapter.export(asset, spec(dir))));
    expect(f.overlapped()).toBe(false);
    expect(done.map((d) => path.basename(d.file))).toEqual(["IMG_1.jpg", "IMG_2.jpg", "IMG_3.jpg"]);
    expect(f.calls.filter((call) => call.args[0] !== "--version").map((call) => path.basename(call.args[0]!))).toEqual(["IMG_1.CR3", "IMG_2.CR3", "IMG_3.CR3"]);
  });

  it("stops a running export when the job is cancelled, and removes what it had started", async () => {
    const dir = workspace();
    const asset = raw(dir);
    const f = fakeDarktable({ exportMs: 2000 });
    const adapter = new DarktableAdapter({ run: f.run, configDir: path.join(dir, "c") });
    const running = adapter.export(asset, spec(dir), { jobId: "job-x" });
    await new Promise((r) => setTimeout(r, 30));
    await adapter.cancel("job-x");
    await expect(running).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });
    expect(existsSync(path.join(dir, "out", "IMG_0412.jpg"))).toBe(false);
    // A job that is not running is not affected.
    await expect(adapter.cancel("nothing")).resolves.toBeUndefined();
  });

  it("stays in the folder it was given, whatever file name it is asked for", async () => {
    const dir = workspace();
    const asset = raw(dir);
    const adapter = new DarktableAdapter({ run: fakeDarktable().run, configDir: path.join(dir, "c") });
    const out = await adapter.export(asset, spec(dir, { fileName: path.join("..", "..", "escaped") }));
    expect(path.dirname(out.file)).toBe(path.join(dir, "out"));
    expect(path.basename(out.file)).toBe("escaped.jpg");
  });

  it("refuses an installed darktable that is too old to read what it wrote", async () => {
    const dir = workspace();
    const asset = raw(dir);
    const adapter = new DarktableAdapter({ run: fakeDarktable({ version: "5.2.0" }).run, configDir: path.join(dir, "c") });
    await adapter.detect();
    await expect(adapter.export(asset, spec(dir))).rejects.toMatchObject({ code: "ADAPTER_VERSION_UNSUPPORTED" });
  });
});
