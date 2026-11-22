/** A JPEG split into its marker segments, so metadata can be removed or added without touching the pixel data. */
export interface JpegSegment {
  /** Marker byte after 0xFF, e.g. 0xE1 for APP1. */
  marker: number;
  /** Everything from the 0xFF marker byte through the end of the segment (including the length bytes). */
  bytes: Uint8Array;
}

/** A marker segment that sits between scans, located inside `ParsedJpeg.scan`. */
export interface ScanSegment {
  marker: number;
  /** Offsets into `scan`: start inclusive, end exclusive. */
  start: number;
  end: number;
}

export interface ParsedJpeg {
  /** Segments before the first scan (APPn, DQT, SOF, DHT, ...). */
  headers: JpegSegment[];
  /** The first SOS header through EOI inclusive; to the end of the file when the image is cut off before an EOI. */
  scan: Uint8Array;
  /**
   * Marker segments found after the first scan header (later scans' headers, tables and, in odd files, metadata).
   * Metadata is allowed to appear there too, so anything that looks for it must look here as well as in `headers`.
   */
  scanSegments: ScanSegment[];
  /** Bytes after EOI: appended images, motion-photo video, padding. Empty when there are none. */
  trailer: Uint8Array;
}

const NO_BYTES = new Uint8Array(0);

/**
 * Walks image data from its first SOS marker: scan header, entropy-coded data, then any further segments and scans,
 * until EOI. `scan` must start at an SOS marker. Offsets are into `scan`. `end` is just past EOI, or undefined when
 * the data stops (or stops making sense) before one.
 */
function walkScans(scan: Uint8Array): { segments: ScanSegment[]; end: number | undefined } {
  const buf = Buffer.from(scan.buffer, scan.byteOffset, scan.byteLength);
  const segments: ScanSegment[] = [];
  let i = 0;
  let first = true;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) return { segments, end: undefined };
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte before a marker
      continue;
    }
    if (marker === 0xd9) return { segments, end: i + 2 };
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2; // standalone markers carry no length
      continue;
    }
    if (marker === 0x00 || i + 4 > buf.length) return { segments, end: undefined };
    const end = i + 2 + buf.readUInt16BE(i + 2);
    if (end < i + 4 || end > buf.length) return { segments, end: undefined };
    if (!first) segments.push({ marker, start: i, end });
    first = false;
    i = end;
    if (marker !== 0xda) continue;

    // Entropy-coded data follows a scan header and ends at the next marker that is not a stuffed 0xFF00, an RSTn or fill.
    for (;;) {
      const j = buf.indexOf(0xff, i);
      if (j < 0 || j + 1 >= buf.length) return { segments, end: undefined };
      const next = buf[j + 1]!;
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) i = j + 2;
      else if (next === 0xff) i = j + 1;
      else {
        i = j;
        break;
      }
    }
  }
  return { segments, end: undefined };
}

/** Splits a JPEG at the start of scan. Returns undefined if it is not a JPEG. */
export function parseJpeg(file: Uint8Array): ParsedJpeg | undefined {
  if (file[0] !== 0xff || file[1] !== 0xd8) return undefined;
  const headers: JpegSegment[] = [];
  let i = 2;
  while (i + 3 < file.length) {
    if (file[i] !== 0xff) return undefined;
    const marker = file[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xda) {
      const rest = file.subarray(i);
      const { segments, end } = walkScans(rest);
      const stop = end ?? rest.length;
      return { headers, scan: rest.subarray(0, stop), scanSegments: segments, trailer: end === undefined ? NO_BYTES : rest.subarray(stop) };
    }
    if (marker === 0xd9) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = (file[i + 2]! << 8) | file[i + 3]!;
    if (length < 2 || i + 2 + length > file.length) return undefined;
    headers.push({ marker, bytes: file.subarray(i, i + 2 + length) });
    i += 2 + length;
  }
  return undefined;
}

/** Reassembles a JPEG. The trailer is only written when given: scrubbing leaves it out on purpose. */
export function buildJpeg(headers: readonly JpegSegment[], scan: Uint8Array, trailer: Uint8Array = NO_BYTES): Uint8Array {
  const parts = [Uint8Array.of(0xff, 0xd8), ...headers.map((h) => h.bytes), scan, trailer];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function segmentText(segment: JpegSegment, from: number, length: number): string {
  return Buffer.from(segment.bytes.subarray(4 + from, 4 + from + length)).toString("latin1");
}

/** Index to insert new metadata at: after JFIF/Exif so decoders still see them first. */
export function metadataInsertIndex(headers: readonly JpegSegment[]): number {
  let i = 0;
  while (i < headers.length && (headers[i]!.marker === 0xe0 || (headers[i]!.marker === 0xe1 && segmentText(headers[i]!, 0, 4) === "Exif"))) i++;
  return i;
}

const ICC_TAG = "ICC_PROFILE\0";
export const isIccSegment = (s: JpegSegment) => s.marker === 0xe2 && segmentText(s, 0, ICC_TAG.length) === ICC_TAG;

/** Pixel size from the frame header, without decoding. Undefined if it is missing or defined later (DNL). */
export function jpegSize(parsed: ParsedJpeg): { width: number; height: number } | undefined {
  const sof = parsed.headers.find((h) => h.marker >= 0xc0 && h.marker <= 0xcf && h.marker !== 0xc4 && h.marker !== 0xc8 && h.marker !== 0xcc);
  if (!sof || sof.bytes.length < 9) return undefined;
  const height = (sof.bytes[5]! << 8) | sof.bytes[6]!;
  const width = (sof.bytes[7]! << 8) | sof.bytes[8]!;
  return width > 0 && height > 0 ? { width, height } : undefined;
}
