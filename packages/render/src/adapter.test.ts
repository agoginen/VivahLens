import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { afterAll, describe, expect, it } from "vitest";
import type { AssetRef, EditRecipe } from "@vivahlens/core";
import { findExifSegment, readOrientation } from "@vivahlens/ingest";
import { adapterContract, makeExifSegment } from "@vivahlens/testkit";
import { insertExif } from "@vivahlens/ingest";
import { RenderAdapter, recipeSidecarPath } from "./adapter.js";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vivah-render-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A JPEG on disk: a mid-grey frame with a bright square top-left, carrying EXIF that says it is stored on its side. */
function writePhoto(dir: string, name = "IMG_0001.jpg", opts: { width?: number; height?: number; orientation?: number } = {}): AssetRef {
  const width = opts.width ?? 96;
  const height = opts.height ?? 64;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(x < 16 && y < 16 ? [250, 250, 250, 255] : [119, 119, 119, 255], (y * width + x) * 4);
  }
  const bytes = insertExif(new Uint8Array(jpeg.encode({ data, width, height }, 95).data), makeExifSegment({ orientation: opts.orientation ?? 1, width, height }));
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  return { id: name, kind: "photo", path: file };
}

const decode = (file: string) => jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true });
const pixel = (img: { width: number; data: Uint8Array }, x: number, y: number) => img.data[(y * img.width + x) * 4]!;
const bright: EditRecipe = { version: "1.0", assetType: "photo", adjustments: { exposure: 1 } };

const outDir = temp();
adapterContract({
  name: "builtin-render",
  create: () => ({ adapter: new RenderAdapter({ backupDir: path.join(temp(), "backups") }) }),
  asset: () => writePhoto(temp()),
  exportSpec: { format: "jpeg", outputDir: outDir, quality: 85 },
});

describe("the built-in renderer as an editor", () => {
  it("keeps the recipe next to the picture and draws it on export, to the size and name asked for", async () => {
    const dir = temp();
    const asset = writePhoto(dir);
    const adapter = new RenderAdapter();
    const applied = await adapter.applyRecipe(asset, bright);
    expect(applied.outputs).toEqual([recipeSidecarPath(asset.path)]);
    expect(path.basename(applied.outputs[0]!)).toBe("IMG_0001.vivah.json");

    const result = await adapter.export(asset, { format: "jpeg", outputDir: path.join(dir, "out"), maxEdgePx: 48, fileName: "wedding-001" });
    expect(path.basename(result.file)).toBe("wedding-001.jpg");
    const exported = decode(result.file);
    expect([exported.width, exported.height]).toEqual([48, 32]);
    expect(pixel(exported, 40, 20)).toBeGreaterThan(155); // the 119 grey, one stop brighter
    expect(pixel(exported, 40, 20)).toBeLessThan(172);
  });

  it("exports the same picture a second time, from the recipe on disk, even in a fresh adapter (resumable)", async () => {
    const dir = temp();
    const asset = writePhoto(dir);
    await new RenderAdapter().applyRecipe(asset, bright);
    const out = await new RenderAdapter().export(asset, { format: "jpeg", outputDir: path.join(dir, "out") });
    expect(decode(out.file).width).toBe(96);
  });

  it("carries the camera's EXIF into the export, upright and with the new size", async () => {
    const dir = temp();
    const asset = writePhoto(dir, "IMG_0002.jpg", { orientation: 6, width: 96, height: 64 });
    const adapter = new RenderAdapter();
    await adapter.applyRecipe(asset, bright);
    const { file } = await adapter.export(asset, { format: "jpeg", outputDir: path.join(dir, "out"), maxEdgePx: 32 });
    const bytes = readFileSync(file);
    const exif = findExifSegment(bytes)!;
    expect(exif).toBeDefined();
    expect(readOrientation(bytes)).toBe(1);
    const view = new DataView(exif.slice(10).buffer);
    const exported = decode(file);
    expect([exported.width, exported.height]).toEqual([21, 32]);
    expect(view.getUint32(48)).toBe(exported.width);
    expect(view.getUint32(60)).toBe(exported.height);
  });

  it("turns a picture stored on its side upright before editing", async () => {
    const dir = temp();
    const asset = writePhoto(dir, "IMG_0003.jpg", { orientation: 6, width: 96, height: 64 });
    const adapter = new RenderAdapter();
    await adapter.applyRecipe(asset, { ...bright, adjustments: {} });
    const { file } = await adapter.export(asset, { format: "jpeg", outputDir: path.join(dir, "out") });
    const exported = decode(file);
    expect([exported.width, exported.height]).toEqual([64, 96]);
    expect(pixel(exported, 60, 4)).toBeGreaterThan(220); // the bright square moved from top-left to top-right
    expect(pixel(exported, 4, 4)).toBeLessThan(140);
  });

  it("says what it cannot do instead of failing", async () => {
    const dir = temp();
    const asset = writePhoto(dir);
    const adapter = new RenderAdapter();
    const withLut: EditRecipe = { version: "1.0", assetType: "photo", adjustments: { exposure: 0.5, lutRef: "warm.cube" } };
    expect((await adapter.applyRecipe(asset, withLut)).warnings).toEqual([expect.stringContaining("lutRef")]);
    expect(adapter.translateRecipe(withLut)).toMatchObject({ kind: "vivah-recipe", unsupported: ["lutRef"] });

    await expect(adapter.applyRecipe(asset, { version: "2.0" } as unknown as EditRecipe)).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED" });
    await expect(adapter.export(asset, { format: "tiff", outputDir: dir })).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED", message: expect.stringContaining("JPEG only") });
    await expect(adapter.export(writePhoto(dir, "never-edited.jpg"), { format: "jpeg", outputDir: dir })).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED", message: expect.stringContaining("No recipe") });
    writeFileSync(recipeSidecarPath(asset.path), "{not json");
    await expect(adapter.export(asset, { format: "jpeg", outputDir: dir })).rejects.toMatchObject({ message: expect.stringContaining("does not hold a valid recipe") });
  });

  it("keeps a copy of a recipe it replaces so the apply can be undone, and says when it cannot", async () => {
    const dir = temp();
    const asset = writePhoto(dir);
    const backups = path.join(temp(), "backups");
    const adapter = new RenderAdapter({ backupDir: backups });
    const first = await adapter.applyRecipe(asset, bright, { jobId: "j1" });
    expect(first.replaced).toEqual([expect.objectContaining({ target: recipeSidecarPath(asset.path) })]);
    expect(first.replaced![0]!.backup).toBeUndefined(); // the file was new: undo deletes it
    const second = await adapter.applyRecipe(asset, { ...bright, adjustments: { exposure: -1 } }, { jobId: "j1" });
    expect(existsSync(second.replaced![0]!.backup!)).toBe(true);
    expect(readFileSync(second.replaced![0]!.backup!, "utf8")).toContain('"exposure": 1');

    const noBackups = await new RenderAdapter().applyRecipe(asset, bright);
    expect(noBackups.replaced).toBeUndefined();
    expect(noBackups.warnings).toEqual([expect.stringContaining("cannot be undone")]);
  });

  it("stops before drawing when the job is cancelled, and refuses anything that is not a photo", async () => {
    const dir = temp();
    const asset = writePhoto(dir);
    const adapter = new RenderAdapter();
    await adapter.applyRecipe(asset, bright);
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.export(asset, { format: "jpeg", outputDir: path.join(dir, "out") }, { signal: controller.signal })).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });
    expect(existsSync(path.join(dir, "out"))).toBe(false);
    await expect(adapter.applyRecipe({ id: "clip", kind: "video", path: "clip.mov" }, bright)).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED" });
  });
});
