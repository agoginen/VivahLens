import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { makeExifSegment } from "@vivahlens/testkit";
import { findExifSegment, insertExif, patchExif } from "./exifSegment.js";
import { readOrientation } from "./orientation.js";

const plainJpeg = () => {
  const data = new Uint8Array(16 * 12 * 4).fill(200);
  return new Uint8Array(jpeg.encode({ data, width: 16, height: 12 }, 80).data);
};

describe("EXIF blocks", () => {
  it("carries an EXIF block into a JPEG that has none, where readers still find it and the picture still decodes", () => {
    const exif = makeExifSegment({ orientation: 6 });
    const bare = plainJpeg();
    expect(findExifSegment(bare)).toBeUndefined();

    const withExif = insertExif(bare, exif);
    expect(Array.from(findExifSegment(withExif)!)).toEqual(Array.from(exif));
    expect(readOrientation(withExif)).toBe(6);
    expect(jpeg.decode(withExif, { useTArray: true }).width).toBe(16);
    expect(withExif.length).toBe(bare.length + exif.length);
    // Placed after the JFIF header, so the file still starts the way every reader expects.
    expect(Array.from(withExif.subarray(0, 4))).toEqual([0xff, 0xd8, 0xff, 0xe0]);
  });

  it("corrects orientation and pixel dimensions, in either byte order, without touching the original block", () => {
    for (const littleEndian of [false, true]) {
      const original = makeExifSegment({ orientation: 8, width: 6000, height: 4000, littleEndian });
      const snapshot = Array.from(original);
      const patched = patchExif(original, { orientation: 1, width: 2048, height: 1365 });
      expect(Array.from(original)).toEqual(snapshot);
      expect(readOrientation(insertExif(plainJpeg(), patched)), `little=${littleEndian}`).toBe(1);

      const again = patchExif(makeExifSegment({ orientation: 3, littleEndian }), { orientation: 1 });
      expect(Array.from(again)).toEqual(Array.from(makeExifSegment({ orientation: 1, littleEndian })));

      const view = new DataView(patched.slice(10).buffer);
      expect(view.getUint32(48, littleEndian)).toBe(2048);
      expect(view.getUint32(60, littleEndian)).toBe(1365);
    }
  });

  it("only changes what it is told to", () => {
    const original = makeExifSegment({ orientation: 6, width: 6000, height: 4000 });
    expect(Array.from(patchExif(original, {}))).toEqual(Array.from(original));
    const onlyOrientation = patchExif(original, { orientation: 1 });
    expect(Array.from(onlyOrientation)).toEqual(Array.from(makeExifSegment({ orientation: 1, width: 6000, height: 4000 })));
  });

  it("never changes the bytes it was given, even when they are a Node Buffer whose slices share memory", () => {
    const file = Buffer.from(insertExif(plainJpeg(), makeExifSegment({ orientation: 6 })));
    const before = Buffer.from(file);
    const exif = findExifSegment(file)!;
    patchExif(exif, { orientation: 1, width: 1, height: 1 });
    exif.fill(0);
    expect(file.equals(before)).toBe(true);
    patchExif(Buffer.from(exif), { orientation: 1 });
  });

  it("copes with a block that is cut short or is not EXIF at all", () => {
    const original = makeExifSegment({ orientation: 6 });
    for (const length of [0, 5, 12, 20, 30, 45, 60]) {
      expect(() => patchExif(original.subarray(0, length), { orientation: 1, width: 1, height: 1 }), `length ${length}`).not.toThrow();
    }
    const notTiff = original.slice();
    notTiff[13] = 0x00;
    expect(Array.from(patchExif(notTiff, { orientation: 1 }))).toEqual(Array.from(notTiff));
    expect(findExifSegment(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined();
    expect(findExifSegment(new Uint8Array(0))).toBeUndefined();
  });
});
