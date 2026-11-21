import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { afterAll, describe, expect, it } from "vitest";
import { extractEmbeddedJpeg } from "./embeddedJpeg.js";
import { loadGray, loadPreview, scanFolder } from "./images.js";

/** A JPEG with a horizontal ramp plus detail, so it decodes to something non-trivial. */
function makeJpeg(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = Math.round((x / width) * 200) + ((x + y) % 2) * 30;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ data, width, height }, 90).data);
}

/** Mimics a RAW container: header bytes, a small thumbnail, filler, then the full-size preview. */
function fakeRaw(thumb: Buffer, preview: Buffer): Buffer {
  return Buffer.concat([Buffer.from("II*\0fakeraw-header"), thumb, Buffer.alloc(64, 0x11), preview, Buffer.alloc(32, 0x22)]);
}

describe("extractEmbeddedJpeg", () => {
  const thumb = makeJpeg(16, 16);
  const preview = makeJpeg(160, 120);

  it("returns the largest embedded JPEG, not the thumbnail", () => {
    const found = extractEmbeddedJpeg(fakeRaw(thumb, preview));
    expect(Buffer.from(found!).equals(preview)).toBe(true);
  });

  it("returns the whole file for a plain JPEG and undefined when none is embedded", () => {
    expect(Buffer.from(extractEmbeddedJpeg(preview)!).equals(preview)).toBe(true);
    expect(extractEmbeddedJpeg(Buffer.from("not an image at all"))).toBeUndefined();
  });

  it("ignores a truncated JPEG", () => {
    expect(extractEmbeddedJpeg(preview.subarray(0, preview.length - 40))).toBeUndefined();
  });
});

describe("loading from files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vivah-ingest-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "B.NEF"), fakeRaw(makeJpeg(16, 16), makeJpeg(400, 300)));
  writeFileSync(path.join(dir, "A.jpg"), makeJpeg(100, 100));
  writeFileSync(path.join(dir, "notes.txt"), "x");
  writeFileSync(path.join(dir, "broken.CR3"), "no preview here");

  it("lists only image files in stable order", async () => {
    expect((await scanFolder(dir)).map((a) => a.id)).toEqual(["A.jpg", "B.NEF", "broken.CR3"]);
  });

  it("produces a downscaled JPEG preview that is never upscaled", async () => {
    const big = await loadPreview({ id: "B", kind: "photo", path: path.join(dir, "B.NEF") }, { maxEdge: 200 });
    const decoded = jpeg.decode(Buffer.from(big.dataBase64, "base64"));
    expect([decoded.width, decoded.height]).toEqual([200, 150]);

    const small = await loadPreview({ id: "A", kind: "photo", path: path.join(dir, "A.jpg") }, { maxEdge: 2048 });
    expect(jpeg.decode(Buffer.from(small.dataBase64, "base64")).width).toBe(100);
  });

  it("produces a grayscale image sized for culling", async () => {
    const gray = await loadGray({ id: "B", kind: "photo", path: path.join(dir, "B.NEF") }, { maxEdge: 100 });
    expect([gray.width, gray.height, gray.data.length]).toEqual([100, 75, 7500]);
    expect(gray.data[0]).toBeLessThan(gray.data[99]!);
  });

  it("reports unreadable assets with a stable error code", async () => {
    await expect(loadGray({ id: "x", kind: "photo", path: path.join(dir, "broken.CR3") })).rejects.toMatchObject({
      code: "ASSET_UNREADABLE",
    });
  });
});
