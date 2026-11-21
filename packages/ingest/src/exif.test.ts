import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { afterAll, describe, expect, it } from "vitest";
import { readExif } from "./exif.js";
import { fingerprintFile } from "./fingerprint.js";
import { loadAnalysis } from "./images.js";

/** Builds a TIFF with IFD0 (Make, Model, Orientation, ExifIFD) and an Exif IFD, in either byte order. */
function buildTiff(little: boolean, opts: { orientation?: number; magic?: number } = {}): Buffer {
  const b = Buffer.alloc(220);
  const w16 = (o: number, v: number) => (little ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const w32 = (o: number, v: number) => (little ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  const entry = (o: number, tag: number, type: number, count: number, value: number) => {
    w16(o, tag);
    w16(o + 2, type);
    w32(o + 4, count);
    if (type === 3 && count === 1) w16(o + 8, value);
    else w32(o + 8, value);
  };
  b.write(little ? "II" : "MM", 0, "ascii");
  w16(2, opts.magic ?? 42);
  w32(4, 8);
  // IFD0 at 8: 4 entries (ends at 62); strings at 62 and 68.
  w16(8, 4);
  entry(10, 0x010f, 2, 6, 62);
  entry(22, 0x0110, 2, 7, 68);
  entry(34, 0x0112, 3, 1, opts.orientation ?? 6);
  entry(46, 0x8769, 4, 1, 76);
  b.write("Canon\0", 62, "latin1");
  b.write("EOS R5\0", 68, "latin1");
  // Exif IFD at 76: 6 entries (ends at 154); values from 154.
  w16(76, 6);
  entry(78, 0x829a, 5, 1, 154);
  entry(90, 0x829d, 5, 1, 162);
  entry(102, 0x8827, 3, 1, 400);
  entry(114, 0x9003, 2, 20, 170);
  entry(126, 0x920a, 5, 1, 190);
  entry(138, 0xa434, 2, 13, 198);
  w32(154, 1);
  w32(158, 250);
  w32(162, 28);
  w32(166, 10);
  b.write("2026:11:20 14:30:05\0", 170, "latin1");
  w32(190, 85);
  w32(194, 1);
  b.write("RF85mm F1.2L\0", 198, "latin1");
  return b;
}

describe("readExif", () => {
  it.each([
    ["little-endian", true],
    ["big-endian", false],
  ])("reads camera, lens, exposure and time from a %s TIFF-based RAW", (_name, little) => {
    expect(readExif(buildTiff(little))).toEqual({
      make: "Canon",
      model: "EOS R5",
      orientation: 6,
      exposureTime: 1 / 250,
      fNumber: 2.8,
      iso: 400,
      focalLengthMm: 85,
      lensModel: "RF85mm F1.2L",
      capturedAt: "2026-11-20T14:30:05",
    });
  });

  it("accepts Olympus/Panasonic-style magic numbers", () => {
    expect(readExif(buildTiff(true, { magic: 0x4f52 })).model).toBe("EOS R5");
  });

  it("reads EXIF from a JPEG's APP1 segment and falls back to the embedded preview", () => {
    const tiff = buildTiff(true);
    const body = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
    const seg = Buffer.alloc(4);
    seg.writeUInt16BE(0xffe1, 0);
    seg.writeUInt16BE(body.length + 2, 2);
    const base = Buffer.from(jpeg.encode({ data: Buffer.alloc(16 * 16 * 4, 128), width: 16, height: 16 }, 80).data);
    const withExif = Buffer.concat([base.subarray(0, 2), seg, body, base.subarray(2)]);

    expect(readExif(withExif).lensModel).toBe("RF85mm F1.2L");
    // A container without readable EXIF of its own borrows the preview's.
    expect(readExif(Buffer.from("not a tiff, not a jpeg"), withExif).capturedAt).toBe("2026-11-20T14:30:05");
  });

  it("never throws on truncated or hostile input", () => {
    const tiff = buildTiff(true);
    for (let cut = 0; cut < tiff.length; cut += 7) expect(() => readExif(tiff.subarray(0, cut))).not.toThrow();
    const hostile = Buffer.from(tiff);
    hostile.writeUInt32LE(0xfffffff0, 4);
    expect(readExif(hostile)).toEqual({});
  });
});

describe("fingerprintFile and loadAnalysis", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vivah-fp-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("matches identical files, distinguishes small edits, and handles files larger than the sample", async () => {
    const big = Buffer.alloc(4 * 1024 * 1024, 7);
    writeFileSync(path.join(dir, "a.bin"), big);
    writeFileSync(path.join(dir, "copy.bin"), big);
    const changedMiddle = Buffer.from(big);
    changedMiddle[2 * 1024 * 1024] = 9;
    writeFileSync(path.join(dir, "mid.bin"), changedMiddle);
    writeFileSync(path.join(dir, "small.bin"), "tiny");

    const [a, copy, mid, small] = await Promise.all(["a.bin", "copy.bin", "mid.bin", "small.bin"].map((n) => fingerprintFile(path.join(dir, n))));
    expect(a).toBe(copy);
    expect(a).not.toBe(mid);
    expect(small).toHaveLength(64);
  });

  it("derives gray image, scene stats and EXIF from a single decode", async () => {
    // Warm (red-heavy) mid-bright image.
    const [w, h] = [64, 48];
    const rgba = Buffer.alloc(w * h * 4, 255);
    for (let i = 0; i < w * h; i++) rgba.set([220, 140, 60], i * 4);
    const file = path.join(dir, "warm.jpg");
    writeFileSync(file, Buffer.from(jpeg.encode({ data: rgba, width: w, height: h }, 90).data));

    const a = await loadAnalysis({ id: "warm", kind: "photo", path: file });
    expect([a.gray.width, a.gray.height]).toEqual([64, 48]);
    expect(a.scene.meanLuma).toBeGreaterThan(120);
    expect(a.scene.tempK).toBeLessThan(5000);
    expect(a.exif).toEqual({});
  });
});
