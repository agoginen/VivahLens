import jpeg from "jpeg-js";
import { parseJpeg } from "../jpegSegments.js";
import { isXmpSegment, xmpText } from "../xmp.js";

/** Builders for the JPEG and TIFF files the delivery tests need. Not part of the package build. */

export const solidJpeg = (w: number, h: number, rgb: [number, number, number], quality = 90) => {
  const data = Buffer.alloc(w * h * 4, 255);
  for (let i = 0; i < w * h; i++) data.set(rgb, i * 4);
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, quality).data);
};

/** A JPEG with extra segments inserted right after SOI. */
export function withSegments(base: Buffer, segments: Buffer[]): Buffer {
  return Buffer.concat([base.subarray(0, 2), ...segments, base.subarray(2)]);
}

/** A JPEG marker segment: marker, length, payload. */
export const app = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);

/** A recognisable 32-bit pattern; `contains` finds it in either byte order. */
export const GPS_MARKER = 0xdeadbeef;
export const OTHER_MARKER = 0x0badf00d;
export const NEXT_IFD = 0x00c0ffee;

export const contains = (buf: Uint8Array, value: number) => {
  const big = Buffer.alloc(4);
  big.writeUInt32BE(value);
  const little = Buffer.alloc(4);
  little.writeUInt32LE(value);
  const haystack = Buffer.from(buf);
  return haystack.includes(big) || haystack.includes(little);
};

/** `size` bytes made of repeats of `marker` (little-endian), to stand in for coordinates stored out of line. */
export function marked(marker: number, size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i + 4 <= size; i += 4) out.writeUInt32LE(marker, i);
  return out;
}

/** TIFF with Make, a GPS IFD (pointer in the middle of IFD0, so removal has to shift entries) and Orientation. */
export function tiffWithGps(little: boolean, orientation = 1): Buffer {
  const b = Buffer.alloc(160);
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
  w16(2, 42);
  w32(4, 8);
  w16(8, 3);
  entry(10, 0x010f, 2, 6, 50);
  entry(22, 0x8825, 4, 1, 56);
  entry(34, 0x0112, 3, 1, orientation);
  w32(46, NEXT_IFD);
  b.write("Canon\0", 50, "latin1");
  w16(56, 4);
  entry(58, 0x0001, 2, 2, 0);
  b.write("N\0", 66, "latin1");
  entry(70, 0x0002, 5, 3, 110);
  entry(82, 0x0003, 2, 2, 0);
  b.write("E\0", 90, "latin1");
  entry(94, 0x0004, 5, 3, 134);
  w32(110, GPS_MARKER);
  w32(114, 1);
  w32(134, OTHER_MARKER);
  w32(138, 1);
  return b;
}

export type FieldValue = number | Buffer | { ifd: number } | { blob: Buffer };
export interface Field {
  tag: number;
  type: number;
  count: number;
  value: FieldValue;
}
export interface IfdSpec {
  fields: Field[];
  /** Index of the IFD linked after this one. */
  next?: number;
}

/**
 * Lays out TIFF IFDs and the data they point to. A number is stored inline, a Buffer of more than four bytes out of
 * line, `{ ifd }` is the offset of another IFD and `{ blob }` is stored out of line with the field holding its offset.
 */
export function assembleTiff(ifds: IfdSpec[], little = true): Buffer {
  const offsets: number[] = [];
  let cursor = 8;
  for (const ifd of ifds) {
    offsets.push(cursor);
    cursor += 2 + ifd.fields.length * 12 + 4;
  }
  const outOfLine = (f: Field): Buffer | undefined => {
    if (Buffer.isBuffer(f.value)) return f.value.length > 4 ? f.value : undefined;
    return typeof f.value === "object" && "blob" in f.value ? f.value.blob : undefined;
  };
  const placed = new Map<Field, number>();
  for (const ifd of ifds) {
    for (const f of ifd.fields) {
      const bytes = outOfLine(f);
      if (!bytes) continue;
      placed.set(f, cursor);
      cursor += bytes.length + (bytes.length % 2);
    }
  }

  const b = Buffer.alloc(cursor);
  const w16 = (o: number, v: number) => (little ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const w32 = (o: number, v: number) => (little ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  b.write(little ? "II" : "MM", 0, "ascii");
  w16(2, 42);
  w32(4, offsets[0]!);
  ifds.forEach((ifd, n) => {
    let at = offsets[n]!;
    w16(at, ifd.fields.length);
    at += 2;
    for (const f of ifd.fields) {
      w16(at, f.tag);
      w16(at + 2, f.type);
      w32(at + 4, f.count);
      const bytes = outOfLine(f);
      if (bytes) {
        w32(at + 8, placed.get(f)!);
        bytes.copy(b, placed.get(f)!);
      } else if (Buffer.isBuffer(f.value)) f.value.copy(b, at + 8);
      else if (typeof f.value === "number") {
        if (f.type === 3 && f.count === 1) w16(at + 8, f.value);
        else w32(at + 8, f.value);
      } else if ("ifd" in f.value) w32(at + 8, offsets[f.value.ifd]!);
      at += 12;
    }
    w32(at, ifd.next === undefined ? 0 : offsets[ifd.next]!);
  });
  return b;
}

export const exifApp = (tiff: Buffer) => app(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]));
export const xmpApp = (body: string) => app(0xe1, Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), Buffer.from(body)]));
export const iccApp = (profile = "fake-profile-bytes") => app(0xe2, Buffer.concat([Buffer.from("ICC_PROFILE\0\x01\x01", "latin1"), Buffer.from(profile)]));

/** An APP13 Photoshop block made of the given image resources (id and data). */
export function photoshopApp(resources: { id: number; data: Buffer }[]): Buffer {
  const parts = resources.map(({ id, data }) => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    return Buffer.concat([Buffer.from("8BIM"), Buffer.from([id >> 8, id & 255, 0, 0]), size, data, data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
  });
  return app(0xed, Buffer.concat([Buffer.from("Photoshop 3.0\0", "latin1"), ...parts]));
}

/** IPTC-IIM data sets for creator (2:80) and copyright (2:116). */
export function iim(fields: { creator?: string; copyright?: string }): Buffer {
  const set = (tag: number, text: string) => {
    const value = Buffer.from(text, "utf8");
    return Buffer.concat([Buffer.from([0x1c, 2, tag, value.length >> 8, value.length & 255]), value]);
  };
  return Buffer.concat([fields.creator ? set(80, fields.creator) : Buffer.alloc(0), fields.copyright ? set(116, fields.copyright) : Buffer.alloc(0)]);
}

export const xmpOf = (data: Uint8Array) => {
  const seg = parseJpeg(data)!.headers.find(isXmpSegment);
  return seg ? xmpText(seg) : undefined;
};

/** The Exif segment of a file, as the TIFF structure inside it. */
export function exifTiff(data: Uint8Array): Buffer | undefined {
  const seg = parseJpeg(data)!.headers.find((h) => h.marker === 0xe1 && Buffer.from(h.bytes.subarray(4, 8)).toString("latin1") === "Exif");
  return seg ? Buffer.from(seg.bytes.subarray(10)) : undefined;
}

/** IFD0 as stored in the file's Exif segment: its entry tags in order, and the next-IFD offset that follows them. */
export function ifd0(data: Uint8Array): { tags: number[]; next: number } {
  const b = exifTiff(data)!;
  const little = b[0] === 0x49;
  const u16 = (o: number) => (little ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o: number) => (little ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const at = u32(4);
  const n = u16(at);
  return { tags: Array.from({ length: n }, (_, i) => u16(at + 2 + i * 12)), next: u32(at + 2 + n * 12) };
}

/** The entropy-coded image data, as hex so Buffer and Uint8Array inputs compare equal. */
export const scanHex = (data: Uint8Array) => Buffer.from(parseJpeg(data)!.scan).toString("hex");
