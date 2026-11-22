import { segmentText, type JpegSegment } from "./jpegSegments.js";

export const XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0";
const DC_NS = "http://purl.org/dc/elements/1.1/";
/** A JPEG segment holds at most 65533 payload bytes; longer XMP needs the "extended XMP" scheme, which is not written here. */
const MAX_PAYLOAD = 65533;

export interface Credit {
  /** Copyright notice (dc:rights). */
  copyright?: string;
  /** Creator / photographer (dc:creator). */
  creator?: string;
}

export const isXmpSegment = (s: JpegSegment) => s.marker === 0xe1 && segmentText(s, 0, XMP_HEADER.length) === XMP_HEADER;
/** Large XMP is split across APP1 "extension" segments; they are treated as XMP for removal purposes. */
export const isExtendedXmpSegment = (s: JpegSegment) => s.marker === 0xe1 && segmentText(s, 0, 34) === "http://ns.adobe.com/xmp/extension/";

export const xmpText = (s: JpegSegment): string => Buffer.from(s.bytes.subarray(4 + XMP_HEADER.length)).toString("utf8");

export function xmpSegment(xml: string): JpegSegment | undefined {
  const payload = Buffer.concat([Buffer.from(XMP_HEADER, "latin1"), Buffer.from(xml, "utf8")]);
  if (payload.length > MAX_PAYLOAD) return undefined;
  const head = Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
  return { marker: 0xe1, bytes: new Uint8Array(Buffer.concat([head, payload])) };
}

const escapeXml = (s: string) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

// A lookbehind rather than a leading `\s+`: with `\s+` every position of a long whitespace run is tried and each try
// re-scans the rest of the run, which takes seconds on a 64 KB run of spaces.
const GPS_ATTRIBUTE = /(?<=\s)[A-Za-z_][\w.-]*:GPS\w*\s*=\s*(?:"[^"]*"|'[^']*')/g;
// Element names may be unprefixed: RDF/XML allows a default namespace for elements (never for attributes).
const GPS_ELEMENT = /<((?:[A-Za-z_][\w.-]*:)?GPS\w*)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1\s*>)/g;
/** Any tag or prefixed attribute that is still named GPS* after the edit. */
const GPS_LEFTOVER = /<\/?(?:[A-Za-z_][\w.-]*:)?GPS\w|\s[A-Za-z_][\w.-]*:GPS\w/i;

/**
 * Removes the GPS properties (any prefix, attribute or element form) and leaves everything else in the packet alone.
 * `clean` is false when something GPS-like is still left, or the text cannot be read as UTF-8 (`unreadable`), so the
 * caller can drop the packet rather than trust the edit.
 */
export function scrubXmpGps(xml: string): { xml: string; removed: boolean; clean: boolean; unreadable: boolean } {
  // NULs mean UTF-16 (or garbage): the text patterns cannot be trusted on it.
  const unreadable = xml.includes("\u0000");
  const out = xml.replace(GPS_ATTRIBUTE, "").replace(GPS_ELEMENT, "");
  return { xml: out, removed: out !== xml, clean: !unreadable && !GPS_LEFTOVER.test(out), unreadable };
}

function removeProperty(xml: string, name: "creator" | "rights"): string {
  return xml
    .replace(new RegExp(`(?<=\\s)dc:${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`, "g"), "")
    .replace(new RegExp(`<dc:${name}\\b[^>]*?(?:/>|>[\\s\\S]*?</dc:${name}\\s*>)`, "g"), "");
}

function properties(credit: Credit): string {
  const lines: string[] = [];
  if (credit.creator) lines.push(`<dc:creator><rdf:Seq><rdf:li>${escapeXml(credit.creator)}</rdf:li></rdf:Seq></dc:creator>`);
  if (credit.copyright) lines.push(`<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(credit.copyright)}</rdf:li></rdf:Alt></dc:rights>`);
  return lines.join("");
}

/** A minimal packet carrying only the credit, for files that have no usable XMP. */
export function freshXmp(credit: Credit): string {
  return (
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:dc="${DC_NS}">${properties(credit)}</rdf:Description>` +
    `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  );
}

/**
 * Sets dc:creator / dc:rights in an existing packet and keeps everything else (keywords, captions, ...). Returns
 * undefined when the packet's structure is not one this can edit safely.
 */
export function setXmpCredit(xml: string, credit: Credit): string | undefined {
  if (xml.includes("\u0000")) return undefined;
  for (const binding of xml.matchAll(/xmlns:dc\s*=\s*(["'])(.*?)\1/g)) if (binding[2] !== DC_NS) return undefined;
  if (!/<rdf:Description\b/.test(xml)) return undefined;

  let out = xml;
  if (credit.creator) out = removeProperty(out, "creator");
  if (credit.copyright) out = removeProperty(out, "rights");
  const tag = /<rdf:Description\b[^>]*?(\/?)>/.exec(out);
  if (!tag) return undefined;
  const selfClosing = tag[1] === "/";
  const declare = /xmlns:dc\s*=/.test(tag[0]) ? "" : ` xmlns:dc="${DC_NS}"`;
  const start = tag[0].slice(0, tag[0].length - (selfClosing ? 2 : 1)).replace(/\s+$/, "") + declare;
  const replacement = `${start}>${properties(credit)}${selfClosing ? "</rdf:Description>" : ""}`;
  return out.slice(0, tag.index) + replacement + out.slice(tag.index + tag[0].length);
}
