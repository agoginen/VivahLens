export interface ExifInfo {
  make?: string;
  model?: string;
  lensModel?: string;
  iso?: number;
  fNumber?: number;
  /** Seconds, e.g. 0.004 for 1/250. */
  exposureTime?: number;
  focalLengthMm?: number;
  /** Local capture time as written by the camera ("YYYY-MM-DDTHH:MM:SS", no timezone). */
  capturedAt?: string;
  /** EXIF orientation (1–8) of the main image as stored in the file's own TIFF header. */
  orientation?: number;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/** Bounds-checked TIFF reader; every read past the end yields undefined instead of throwing. */
class Tiff {
  private readonly little: boolean;
  constructor(private readonly b: Uint8Array, private readonly base: number, private readonly end: number) {
    this.little = b[base] === 0x49;
  }

  static open(b: Uint8Array, base: number, end = b.length): Tiff | undefined {
    if (base + 8 > end) return undefined;
    const order = b[base];
    if (!((order === 0x49 && b[base + 1] === 0x49) || (order === 0x4d && b[base + 1] === 0x4d))) return undefined;
    const t = new Tiff(b, base, end);
    // 42 is TIFF; Olympus (0x4F52, 0x5352) and Panasonic (0x55) RAW containers reuse the layout.
    const magic = t.u16(base + 2);
    return magic === 42 || magic === 0x4f52 || magic === 0x5352 || magic === 0x55 ? t : undefined;
  }

  u16(o: number): number | undefined {
    if (o < this.base || o + 2 > this.end) return undefined;
    return this.little ? this.b[o]! | (this.b[o + 1]! << 8) : (this.b[o]! << 8) | this.b[o + 1]!;
  }
  u32(o: number): number | undefined {
    const hi = this.u16(this.little ? o + 2 : o);
    const lo = this.u16(this.little ? o : o + 2);
    return hi === undefined || lo === undefined ? undefined : hi * 0x10000 + lo;
  }

  firstIfd(): number | undefined {
    const off = this.u32(this.base + 4);
    return off === undefined ? undefined : this.base + off;
  }

  /** Absolute position of an offset stored in the file, which is relative to the TIFF header. */
  abs(offset: number): number {
    return this.base + offset;
  }

  entries(ifd: number): Map<number, { type: number; count: number; valueAt: number }> {
    const out = new Map<number, { type: number; count: number; valueAt: number }>();
    const n = this.u16(ifd);
    if (n === undefined) return out;
    for (let i = 0; i < Math.min(n, 512); i++) {
      const e = ifd + 2 + i * 12;
      const tag = this.u16(e);
      const type = this.u16(e + 2);
      const count = this.u32(e + 4);
      if (tag === undefined || type === undefined || count === undefined) break;
      const size = (TYPE_SIZE[type] ?? 0) * count;
      const valueAt = size <= 4 ? e + 8 : this.base + (this.u32(e + 8) ?? Number.MAX_SAFE_INTEGER);
      out.set(tag, { type, count, valueAt });
    }
    return out;
  }

  number(entry: { type: number; count: number; valueAt: number } | undefined): number | undefined {
    if (!entry) return undefined;
    if (entry.type === 3) return this.u16(entry.valueAt);
    if (entry.type === 4) return this.u32(entry.valueAt);
    if (entry.type === 5) {
      const num = this.u32(entry.valueAt);
      const den = this.u32(entry.valueAt + 4);
      return num === undefined || !den ? undefined : num / den;
    }
    return undefined;
  }

  text(entry: { type: number; count: number; valueAt: number } | undefined): string | undefined {
    if (!entry || entry.type !== 2 || entry.valueAt + entry.count > this.end || entry.valueAt < this.base) return undefined;
    const bytes = this.b.subarray(entry.valueAt, entry.valueAt + entry.count);
    const nul = bytes.indexOf(0);
    const s = Buffer.from(nul >= 0 ? bytes.subarray(0, nul) : bytes).toString("latin1").trim();
    return s || undefined;
  }
}

function fromTiff(t: Tiff): ExifInfo {
  const info: ExifInfo = {};
  const ifd0 = t.firstIfd();
  if (ifd0 === undefined) return info;
  const e0 = t.entries(ifd0);
  info.make = t.text(e0.get(0x010f));
  info.model = t.text(e0.get(0x0110));
  const orientation = t.number(e0.get(0x0112));
  if (orientation !== undefined && orientation >= 1 && orientation <= 8) info.orientation = orientation;

  const exifPtr = t.number(e0.get(0x8769));
  if (exifPtr !== undefined) {
    const ex = t.entries(t.abs(exifPtr));
    info.exposureTime = t.number(ex.get(0x829a));
    info.fNumber = t.number(ex.get(0x829d));
    info.iso = t.number(ex.get(0x8827));
    info.focalLengthMm = t.number(ex.get(0x920a));
    info.lensModel = t.text(ex.get(0xa434));
    const taken = t.text(ex.get(0x9003));
    const m = taken && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(taken);
    if (m) info.capturedAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  }
  return Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined)) as ExifInfo;
}

/** EXIF from a JPEG's APP1 segment. */
function fromJpeg(jpeg: Uint8Array): ExifInfo {
  let i = 2;
  while (i + 4 < jpeg.length && jpeg[i] === 0xff) {
    const marker = jpeg[i + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const length = (jpeg[i + 2]! << 8) | jpeg[i + 3]!;
    const body = i + 4;
    if (marker === 0xe1 && length >= 14 && String.fromCharCode(...jpeg.subarray(body, body + 4)) === "Exif") {
      const t = Tiff.open(jpeg, body + 6, Math.min(jpeg.length, i + 2 + length));
      return t ? fromTiff(t) : {};
    }
    i += 2 + length;
  }
  return {};
}

/**
 * Camera, lens, exposure and capture time from a RAW (TIFF-based containers), a JPEG, or, as a fallback,
 * the JPEG preview embedded in the file. Never throws: unreadable metadata yields fewer fields.
 */
export function readExif(file: Uint8Array, embeddedPreview?: Uint8Array): ExifInfo {
  try {
    const isJpeg = file[0] === 0xff && file[1] === 0xd8;
    const direct = isJpeg ? fromJpeg(file) : (() => {
      const t = Tiff.open(file, 0);
      return t ? fromTiff(t) : {};
    })();
    if (direct.capturedAt || !embeddedPreview) return direct;
    return { ...fromJpeg(embeddedPreview), ...direct };
  } catch {
    return {};
  }
}
