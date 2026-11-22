import { crc32, inflateSync } from "node:zlib";
import type { Rgba } from "@vivahlens/ingest";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** A logo, not a photograph: anything larger is refused rather than allocated. */
const MAX_PIXELS = 50_000_000;

/**
 * Minimal PNG reader for logo watermarks: all colour types, bit depths 1–16, tRNS transparency for palette and
 * grayscale images (RGB colour-key transparency is ignored). Interlaced files are not supported (re-save the logo
 * without interlacing). The header's dimensions bound the work: oversized images and image data that inflates beyond
 * what the header describes are refused, so a hostile file cannot exhaust memory.
 */
export function decodePng(file: Uint8Array): Rgba {
  const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("Not a PNG file");

  let width = 0, height = 0, depth = 0, colorType = -1, interlace = 0;
  let palette: Buffer | undefined;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  for (let i = 8; i + 12 <= buf.length; ) {
    const length = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + length);
    if (data.length !== length || i + 12 + length > buf.length) throw new Error("PNG is truncated");
    if (crc32(buf.subarray(i + 4, i + 8 + length)) !== buf.readUInt32BE(i + 8 + length)) throw new Error(`PNG chunk ${type} is corrupt`);
    if (type === "IHDR") {
      [width, height, depth, colorType, interlace] = [data.readUInt32BE(0), data.readUInt32BE(4), data[8]!, data[9]!, data[12]!];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    i += 12 + length;
  }
  if (!width || !height || !(colorType in CHANNELS)) throw new Error("PNG has no valid header");
  if (interlace) throw new Error("Interlaced PNG files are not supported");
  if (![1, 2, 4, 8, 16].includes(depth)) throw new Error(`Unsupported PNG bit depth ${depth}`);
  if (colorType === 3 && !palette) throw new Error("PNG palette is missing");
  if (width * height > MAX_PIXELS) throw new Error(`PNG is too large for a logo (${width}×${height}); use one under ${MAX_PIXELS / 1e6} megapixels`);

  const channels = CHANNELS[colorType]!;
  const bitsPerPixel = channels * depth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const expected = (rowBytes + 1) * height;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch {
    throw new Error("PNG image data is corrupt or larger than its header describes");
  }
  if (raw.length < expected) throw new Error("PNG image data is incomplete");

  // Undo the per-row filters.
  const rows = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)]!;
    if (filter > 4) throw new Error(`Unknown PNG filter ${filter}`);
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= bpp ? rows[dst + x - bpp]! : 0;
      const up = y > 0 ? rows[dst - rowBytes + x]! : 0;
      const upLeft = y > 0 && x >= bpp ? rows[dst - rowBytes + x - bpp]! : 0;
      const v = raw[src + x]!;
      // Buffer writes wrap modulo 256, which is exactly what PNG filtering requires.
      rows[dst + x] = filter === 0 ? v : filter === 1 ? v + left : filter === 2 ? v + up : filter === 3 ? v + ((left + up) >> 1) : v + paeth(left, up, upLeft);
    }
  }

  // Sample reader: value of channel `c` of pixel `x` in row `y`, scaled to 0–255 for depths other than 8.
  const max = (1 << Math.min(depth, 8)) - 1;
  const sample = (y: number, x: number, c: number): number => {
    const rowStart = y * rowBytes;
    if (depth === 8) return rows[rowStart + x * channels + c]!;
    if (depth === 16) return rows[rowStart + (x * channels + c) * 2]!;
    const bit = (x * channels + c) * depth;
    return (rows[rowStart + (bit >> 3)]! >> (8 - depth - (bit & 7))) & max;
  };
  const scale = (v: number) => (depth < 8 && colorType !== 3 ? Math.round((v * 255) / max) : v);

  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const idx = sample(y, x, 0);
        out.set([palette![idx * 3] ?? 0, palette![idx * 3 + 1] ?? 0, palette![idx * 3 + 2] ?? 0, trns?.[idx] ?? 255], o);
      } else if (colorType === 0 || colorType === 4) {
        const g = scale(sample(y, x, 0));
        const key = colorType === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) : undefined;
        out.set([g, g, g, colorType === 4 ? scale(sample(y, x, 1)) : key !== undefined && sample(y, x, 0) === (depth === 16 ? key >> 8 : key) ? 0 : 255], o);
      } else {
        out.set([scale(sample(y, x, 0)), scale(sample(y, x, 1)), scale(sample(y, x, 2)), colorType === 6 ? scale(sample(y, x, 3)) : 255], o);
      }
    }
  }
  return { width, height, data: out };
}
