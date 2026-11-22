import { buildJpeg, metadataInsertIndex, parseJpeg, segmentText, type JpegSegment } from "./jpegSegments.js";

export interface IptcFields {
  /** Copyright notice (IPTC 2:116, at most 128 bytes). */
  copyright?: string;
  /** Creator / by-line (IPTC 2:80, at most 32 bytes). */
  creator?: string;
}

const PHOTOSHOP = "Photoshop 3.0\0";
const IPTC_RESOURCE = 0x0404;

/** Longest prefix of `text` that fits `maxBytes` once encoded as UTF-8; whole code points only, so no character is ever cut in half. */
function clip(text: string, maxBytes: number): Buffer {
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return Buffer.from(out, "utf8");
}

function dataset(record: number, tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x1c, record, tag, value.length >> 8, value.length & 0xff]), value]);
}

/** An APP13 Photoshop segment whose only resource is the given IPTC-IIM block. */
function irbSegment(iim: Buffer): JpegSegment {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(iim.length);
  const resource = Buffer.concat([Buffer.from("8BIM", "latin1"), Buffer.from([0x04, 0x04, 0x00, 0x00]), size, iim, iim.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
  const payload = Buffer.concat([Buffer.from(PHOTOSHOP, "latin1"), resource]);
  const head = Buffer.from([0xff, 0xed, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
  return { marker: 0xed, bytes: new Uint8Array(Buffer.concat([head, payload])) };
}

/** APP13 Photoshop segment carrying the IPTC-IIM fields (UTF-8). */
export function iptcSegment(fields: IptcFields): JpegSegment | undefined {
  const sets: Buffer[] = [];
  if (fields.creator || fields.copyright) sets.push(dataset(1, 90, Buffer.from([0x1b, 0x25, 0x47]))); // charset: UTF-8
  if (fields.creator) sets.push(dataset(2, 80, clip(fields.creator, 32)));
  if (fields.copyright) sets.push(dataset(2, 116, clip(fields.copyright, 128)));
  return sets.length ? irbSegment(Buffer.concat(sets)) : undefined;
}

export const isPhotoshopSegment = (s: JpegSegment) => s.marker === 0xed && segmentText(s, 0, PHOTOSHOP.length) === PHOTOSHOP;
const isPhotoshop = isPhotoshopSegment;

interface Resource {
  id: number;
  dataStart: number;
  size: number;
}

/** The image resources of a Photoshop APP13 segment, up to the first one that is malformed. Never throws. */
function resourcesOf(seg: JpegSegment): { resources: Resource[]; complete: boolean } {
  const b = Buffer.from(seg.bytes.buffer, seg.bytes.byteOffset, seg.bytes.byteLength);
  const resources: Resource[] = [];
  let i = 4 + PHOTOSHOP.length;
  while (i + 12 <= b.length && b.toString("latin1", i, i + 4) === "8BIM") {
    const id = b.readUInt16BE(i + 4);
    const nameBytes = 1 + b[i + 6]! + ((1 + b[i + 6]!) % 2); // Pascal string, padded to an even length
    const sizeAt = i + 6 + nameBytes;
    if (sizeAt + 4 > b.length) break;
    const size = b.readUInt32BE(sizeAt);
    const dataStart = sizeAt + 4;
    if (dataStart + size > b.length) break;
    resources.push({ id, dataStart, size });
    i = dataStart + size + (size % 2);
  }
  return { resources, complete: i >= b.length };
}

/**
 * A Photoshop block reduced to its IPTC-IIM fields. Other resources can hold a second Exif block, an alternative XMP
 * packet or thumbnails, and anything after a malformed resource cannot be inspected, so none of that is carried over.
 * Returns the segment itself when it already holds nothing else, and undefined when there is no IPTC data to keep.
 */
export function iptcOnlySegment(seg: JpegSegment): JpegSegment | undefined {
  const { resources, complete } = resourcesOf(seg);
  const iptc = resources.filter((r) => r.id === IPTC_RESOURCE);
  if (iptc.length === 0) return undefined;
  if (complete && iptc.length === resources.length) return seg;
  const iim = Buffer.concat(iptc.map((r) => Buffer.from(seg.bytes.subarray(r.dataStart, r.dataStart + r.size))));
  return iim.length <= 65_000 ? irbSegment(iim) : undefined;
}

/**
 * Writes copyright/creator into the JPEG's IPTC block without re-encoding, replacing any previous IPTC block
 * (other Photoshop resources are dropped with it, which keeps the file free of stale caption or location data).
 */
export function injectIptc(jpeg: Uint8Array, fields: IptcFields): Uint8Array {
  const parsed = parseJpeg(jpeg);
  const segment = iptcSegment(fields);
  if (!parsed || !segment) return jpeg;
  const headers = parsed.headers.filter((h) => !isPhotoshop(h));
  headers.splice(metadataInsertIndex(headers), 0, segment);
  return buildJpeg(headers, parsed.scan, parsed.trailer);
}

/** Reads copyright/creator back from a JPEG's IPTC block, for verification. Tolerates malformed data. */
export function readIptc(jpeg: Uint8Array): IptcFields {
  const parsed = parseJpeg(jpeg);
  const seg = parsed?.headers.find(isPhotoshop);
  if (!seg) return {};
  const b = Buffer.from(seg.bytes.buffer, seg.bytes.byteOffset, seg.bytes.byteLength);
  const out: IptcFields = {};
  for (const r of resourcesOf(seg).resources) {
    if (r.id !== IPTC_RESOURCE) continue;
    const end = r.dataStart + r.size;
    for (let p = r.dataStart; p + 5 <= end && b[p] === 0x1c; ) {
      const [record, tag] = [b[p + 1]!, b[p + 2]!];
      const len = b.readUInt16BE(p + 3);
      if (p + 5 + len > end) break;
      const value = b.toString("utf8", p + 5, p + 5 + len);
      if (record === 2 && tag === 80) out.creator = value;
      if (record === 2 && tag === 116) out.copyright = value;
      p += 5 + len;
    }
  }
  return out;
}
