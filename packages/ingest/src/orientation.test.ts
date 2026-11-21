import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { applyOrientation, readOrientation } from "./orientation.js";

/** Inserts an APP1/EXIF segment carrying only the orientation tag right after SOI. */
function withOrientation(file: Uint8Array, orientation: number, littleEndian: boolean): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  const w16 = (o: number, v: number) => (littleEndian ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o));
  const w32 = (o: number, v: number) => (littleEndian ? tiff.writeUInt32LE(v, o) : tiff.writeUInt32BE(v, o));
  tiff.write(littleEndian ? "II" : "MM", 0, "ascii");
  w16(2, 42);
  w32(4, 8);
  w16(8, 1);
  w16(10, 0x0112);
  w16(12, 3);
  w32(14, 1);
  w16(18, orientation);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const seg = Buffer.alloc(4);
  seg.writeUInt16BE(0xffe1, 0);
  seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([Buffer.from(file.subarray(0, 2)), seg, body, Buffer.from(file.subarray(2))]);
}

const plain = Buffer.from(jpeg.encode({ data: Buffer.alloc(8 * 4 * 4, 200), width: 8, height: 4 }, 80).data);

describe("EXIF orientation", () => {
  it("reads the tag in both byte orders and defaults to 1", () => {
    expect(readOrientation(withOrientation(plain, 6, true))).toBe(6);
    expect(readOrientation(withOrientation(plain, 8, false))).toBe(8);
    expect(readOrientation(plain)).toBe(1);
    expect(readOrientation(withOrientation(plain, 9, true))).toBe(1);
  });

  it("rotates a 2x1 image so a pixel that was on the left ends up on top for orientation 6", () => {
    // Pixels: red (left), blue (right).
    const img = { width: 2, height: 1, data: Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]) };
    const rotated = applyOrientation(img, 6);
    expect([rotated.width, rotated.height]).toEqual([1, 2]);
    expect(Array.from(rotated.data.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(rotated.data.subarray(4, 8))).toEqual([0, 0, 255, 255]);
  });

  it("mirrors horizontally for 2 and leaves 1 untouched", () => {
    const img = { width: 2, height: 1, data: Uint8Array.from([1, 1, 1, 255, 2, 2, 2, 255]) };
    expect(Array.from(applyOrientation(img, 2).data)).toEqual([2, 2, 2, 255, 1, 1, 1, 255]);
    expect(applyOrientation(img, 1)).toBe(img);
  });
});
