import { iptcOnlySegment, isPhotoshopSegment } from "./iptc.js";
import { buildJpeg, isIccSegment, parseJpeg, segmentText, type JpegSegment, type ParsedJpeg } from "./jpegSegments.js";
import { isExtendedXmpSegment, isXmpSegment, scrubXmpGps, xmpSegment, xmpText } from "./xmp.js";

export interface ScrubResult {
  data: Uint8Array;
  /** Location data was found in Exif or XMP and removed. */
  removed: boolean;
  /**
   * Content dropped without being inspected because it could hide location: "trailing data" (appended images, HDR
   * gain maps, motion-photo video), vendor blocks such as "APP6 block", comments, unreadable Exif or XMP. Empty when
   * nothing was.
   */
  dropped: string[];
}

/** Bytes per value of each TIFF field type, BYTE (1) to IFD (13). */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
const ENTRY = 12;
const MAX_IFDS = 64;
const MAX_DEPTH = 4;
const TIFF_HEADER = 8;

interface TiffOutcome {
  /** The structure could be read. False means the block cannot be trusted. */
  readable: boolean;
  foundGps: boolean;
  changed: boolean;
  /** Where the block can now end: the removed thumbnail was the last thing in it. */
  cutAt?: number;
}

/**
 * Edits a TIFF structure in place (`base` is where its header starts): every GPS pointer in every IFD is deleted and
 * the GPS block it led to is erased, and the thumbnail IFD that follows IFD0 is removed together with its image,
 * which can carry metadata of its own and can show the uncropped original. Nothing is moved, so offsets stay valid.
 */
function scrubTiff(b: Buffer, base: number): TiffOutcome {
  const outcome: TiffOutcome = { readable: false, foundGps: false, changed: false };
  if (b.length < base + TIFF_HEADER) return outcome;
  const little = b[base] === 0x49;
  if (!little && b[base] !== 0x4d) return outcome;
  const u16 = (o: number) => (o >= 0 && o + 2 <= b.length ? (little ? b.readUInt16LE(o) : b.readUInt16BE(o)) : undefined);
  const u32 = (o: number) => (o >= 0 && o + 4 <= b.length ? (little ? b.readUInt32LE(o) : b.readUInt32BE(o)) : undefined);
  const put16 = (o: number, v: number) => void (little ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const put32 = (o: number, v: number) => void (little ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  if (u16(base + 2) !== 42) return outcome;

  const zero = (from: number, length: number) => {
    const start = Math.max(base + TIFF_HEADER, from);
    const end = Math.min(b.length, from + length);
    if (end > start) {
      b.fill(0, start, end);
      outcome.changed = true;
    }
  };

  interface Ifd {
    countAt: number;
    count: number;
    /** The whole table, including the link to the next IFD, lies inside the block. */
    fits: boolean;
  }
  const readIfd = (offset: number | undefined): Ifd | undefined => {
    if (offset === undefined || offset < TIFF_HEADER) return undefined;
    const countAt = base + offset;
    const count = u16(countAt);
    return count === undefined ? undefined : { countAt, count, fits: countAt + 2 + count * ENTRY + 4 <= b.length };
  };
  const entryAt = (ifd: Ifd, i: number) => ifd.countAt + 2 + i * ENTRY;
  const linkAt = (ifd: Ifd) => ifd.countAt + 2 + ifd.count * ENTRY;

  /** Erases a GPS IFD. One whose count runs past the end is still erased as far as it goes: lenient readers read what fits. */
  const eraseGps = (offset: number | undefined) => {
    const gps = readIfd(offset);
    if (!gps) return;
    const usable = Math.min(gps.count, Math.floor((b.length - gps.countAt - 2) / ENTRY));
    for (let k = 0; k < usable; k++) {
      const e = entryAt(gps, k);
      const size = (TYPE_SIZE[u16(e + 2) ?? 0] ?? 0) * (u32(e + 4) ?? 0);
      const at = u32(e + 8);
      if (size > 4 && at !== undefined) zero(base + at, size);
    }
    zero(gps.countAt, 2 + usable * ENTRY + 4);
  };

  const subIfds = (entry: number): number[] => {
    const n = u32(entry + 4) ?? 0;
    if (n < 1 || n > 16) return [];
    if (n === 1) return [u32(entry + 8) ?? 0];
    const at = u32(entry + 8);
    return at === undefined ? [] : Array.from({ length: n }, (_, k) => u32(base + at + k * 4) ?? 0);
  };

  const visited = new Set<number>();
  let budget = MAX_IFDS;
  let failed = false;
  /**
   * Scrubs one IFD and the IFDs it points to; returns it as it is afterwards. Undefined when there is nothing there to
   * read (a pointer outside the block) or it was already handled. An IFD that is there but cannot be handled completely
   * (it runs past the end, or nesting is too deep) is not left behind: the whole block is then not trusted.
   */
  const scrubIfd = (offset: number | undefined, depth: number): Ifd | undefined => {
    const ifd = readIfd(offset);
    if (!ifd || visited.has(ifd.countAt)) return undefined;
    if (!ifd.fits || depth > MAX_DEPTH || budget-- <= 0) {
      failed = true;
      return undefined;
    }
    visited.add(ifd.countAt);
    let i = 0;
    while (i < ifd.count) {
      const entry = entryAt(ifd, i);
      const tag = u16(entry);
      if (tag === 0x8825) {
        eraseGps(u32(entry + 8));
        outcome.foundGps = true;
        // Delete the entry: later entries and the link to the next IFD move up a slot and the count drops by one.
        const end = linkAt(ifd) + 4;
        b.copyWithin(entry, entry + ENTRY, end);
        b.fill(0, end - ENTRY, end);
        ifd.count--;
        put16(ifd.countAt, ifd.count);
        outcome.changed = true;
        continue; // the next entry now sits where this one was
      }
      if (tag === 0x8769 || tag === 0xa005) scrubIfd(u32(entry + 8), depth + 1);
      else if (tag === 0x014a) for (const sub of subIfds(entry)) scrubIfd(sub, depth + 1);
      i++;
    }
    return ifd;
  };

  const thumbnailStarts: number[] = [];
  const dropThumbnail = (ifd: Ifd) => {
    let offset: number | undefined;
    let length: number | undefined;
    for (let i = 0; i < ifd.count; i++) {
      const e = entryAt(ifd, i);
      const tag = u16(e);
      const value = u16(e + 2) === 3 ? u16(e + 8) : u32(e + 8);
      if (tag === 0x0201) offset = value;
      else if (tag === 0x0202) length = value;
    }
    if (offset === undefined || !length) return;
    zero(base + offset, length);
    if (base + offset >= base + TIFF_HEADER) thumbnailStarts.push(base + offset);
  };

  const ifd0 = scrubIfd(u32(base + 4), 0);
  if (!ifd0) return outcome;

  const link = linkAt(ifd0);
  let next = u32(link);
  if (next) {
    for (let hops = 0; next && hops < 4; hops++) {
      const ifd = scrubIfd(next, 1);
      if (!ifd) break;
      dropThumbnail(ifd);
      next = u32(linkAt(ifd));
      zero(ifd.countAt, 2 + ifd.count * ENTRY + 4);
    }
    put32(link, 0);
    outcome.changed = true;
  }
  outcome.readable = !failed;

  // The block can end where the removed thumbnail began if nothing but erased bytes or padding follows it.
  const lowest = Math.min(...thumbnailStarts);
  if (lowest < b.length && b.subarray(lowest).every((byte) => byte === 0)) outcome.cutAt = lowest;
  return outcome;
}

/** The Exif APP1 segment after scrubbing (the input segment itself when nothing changed); `unreadable` means it cannot be trusted. */
function scrubExifSegment(segment: JpegSegment): { segment?: JpegSegment; foundGps: boolean; unreadable: boolean } {
  const b = Buffer.from(segment.bytes); // a copy: the input is never modified
  const r = scrubTiff(b, 10); // marker (2) + length (2) + "Exif\0\0" (6)
  if (!r.readable) return { foundGps: false, unreadable: true };
  if (!r.changed) return { segment, foundGps: false, unreadable: false };
  let out = b;
  if (r.cutAt !== undefined && r.cutAt >= 10 + TIFF_HEADER && r.cutAt < b.length) {
    out = b.subarray(0, r.cutAt);
    out.writeUInt16BE(r.cutAt - 2, 2);
  }
  return { segment: { marker: segment.marker, bytes: new Uint8Array(out) }, foundGps: r.foundGps, unreadable: false };
}

interface Report {
  removed: boolean;
  dropped: Set<string>;
}

const drop = (report: Report, what: string): undefined => {
  report.dropped.add(what);
  return undefined;
};
const startsWith = (h: JpegSegment, text: string) => segmentText(h, 0, text.length) === text;

/**
 * Decides what happens to one metadata segment. Only blocks that are understood survive: JFIF, Exif and XMP (scrubbed),
 * the colour profile, Adobe's colour-transform flag and the IPTC fields. Anything else could hold coordinates in a
 * form this code cannot read (vendor telemetry, comments, a second image), so it is dropped. Returns the segment
 * itself when it is kept as it is, a new one when it was edited, and undefined when it is gone.
 */
function clean(h: JpegSegment, report: Report): JpegSegment | undefined {
  const m = h.marker;
  if (m === 0xfe) return drop(report, "comment");
  if (m >= 0xf0 && m <= 0xfd) return drop(report, "JPEG extension block");
  if (m < 0xe0 || m > 0xef) return h; // frame, table and scan markers are not metadata
  if (m === 0xe0) return startsWith(h, "JFIF\0") ? h : drop(report, "APP0 block");
  if (m === 0xe1) {
    if (startsWith(h, "Exif")) {
      const r = scrubExifSegment(h);
      if (r.unreadable) return drop(report, "unreadable Exif block");
      report.removed ||= r.foundGps;
      return r.segment;
    }
    if (isXmpSegment(h)) {
      const r = scrubXmpGps(xmpText(h));
      if (!r.removed && r.clean) return h;
      if (r.unreadable) return drop(report, "unreadable XMP packet");
      report.removed = true;
      return r.clean ? xmpSegment(r.xml) : undefined;
    }
    return drop(report, isExtendedXmpSegment(h) ? "extended XMP block" : "APP1 block");
  }
  if (m === 0xe2) return isIccSegment(h) ? h : drop(report, "APP2 block");
  if (m === 0xed) return isPhotoshopSegment(h) ? iptcOnlySegment(h) : drop(report, "APP13 block");
  if (m === 0xee) return startsWith(h, "Adobe") ? h : drop(report, "APP14 block");
  return drop(report, `APP${m - 0xe0} block`);
}

/** Metadata is allowed between scans too. The scan data itself is copied untouched. */
function cleanScan(parsed: ParsedJpeg, report: Report): Uint8Array {
  const pieces: Uint8Array[] = [];
  let copied = 0;
  for (const s of parsed.scanSegments) {
    if (s.marker < 0xe0 || s.marker > 0xfe) continue; // table and scan headers
    const segment: JpegSegment = { marker: s.marker, bytes: parsed.scan.subarray(s.start, s.end) };
    const kept = clean(segment, report);
    if (kept === segment) continue;
    pieces.push(parsed.scan.subarray(copied, s.start));
    if (kept) pieces.push(kept.bytes);
    copied = s.end;
  }
  if (pieces.length === 0) return parsed.scan;
  pieces.push(parsed.scan.subarray(copied));
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of pieces) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Padding (zeros, spaces, line ends) after the image is not worth reporting; anything else is content. */
function hasContent(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) return true;
  return false;
}

/**
 * Removes location data from a JPEG without re-encoding it. The Exif GPS block is erased, GPS properties are cut out of
 * XMP, and the file is cut down to what is understood: JFIF, Exif, XMP, the colour profile, Adobe's colour flag and
 * IPTC fields. Everything else is dropped without being inspected (see `ScrubResult.dropped`): vendor blocks,
 * comments, an Exif thumbnail, unreadable Exif or XMP, and anything after the end of the image (appended images,
 * HDR gain maps, motion-photo video). Not detected: location hidden inside a camera's proprietary MakerNote, or typed
 * into IPTC/XMP place-name fields (city, sublocation).
 */
export function scrubGps(jpeg: Uint8Array): ScrubResult {
  const parsed = parseJpeg(jpeg);
  if (!parsed) return { data: jpeg, removed: false, dropped: [] };
  const report: Report = { removed: false, dropped: new Set() };
  let changed = false;

  const headers: JpegSegment[] = [];
  for (const h of parsed.headers) {
    const kept = clean(h, report);
    changed ||= kept !== h;
    if (kept) headers.push(kept);
  }
  const scan = cleanScan(parsed, report);
  changed ||= scan !== parsed.scan;
  if (parsed.trailer.length > 0) {
    changed = true;
    if (hasContent(parsed.trailer)) report.dropped.add("trailing data");
  }
  if (!changed) return { data: jpeg, removed: false, dropped: [] };
  return { data: buildJpeg(headers, scan), removed: report.removed, dropped: [...report.dropped] };
}
