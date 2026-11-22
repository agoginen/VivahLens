import { iptcSegment, isPhotoshopSegment, readIptc } from "./iptc.js";
import { buildJpeg, metadataInsertIndex, parseJpeg } from "./jpegSegments.js";
import { freshXmp, isXmpSegment, setXmpCredit, xmpSegment, xmpText, type Credit } from "./xmp.js";

export type { Credit } from "./xmp.js";

/** Text decoded from a non-UTF-8 block would carry replacement characters; better to drop it than to copy garbage. */
const usable = (s: string | undefined) => (s && !s.includes("\uFFFD") ? s : undefined);

/**
 * Writes the creator and copyright notice into both the IPTC block and the XMP packet, because readers prefer XMP
 * and would otherwise show a stale value from the editor. The XMP packet is edited in place (keywords and captions
 * survive); the IPTC block is replaced by one that carries only the credit. Pixels are not touched.
 */
export function injectCredit(jpeg: Uint8Array, credit: Credit): Uint8Array {
  const fields: Credit = { creator: credit.creator?.trim() || undefined, copyright: credit.copyright?.trim() || undefined };
  const parsed = parseJpeg(jpeg);
  if (!parsed || (!fields.creator && !fields.copyright)) return jpeg;

  const old = readIptc(jpeg);
  const merged: Credit = { creator: fields.creator ?? usable(old.creator), copyright: fields.copyright ?? usable(old.copyright) };
  const headers = parsed.headers.filter((h) => !isPhotoshopSegment(h));

  const at = headers.findIndex(isXmpSegment);
  const patched = at >= 0 ? setXmpCredit(xmpText(headers[at]!), fields) : undefined;
  const xmp = (patched === undefined ? undefined : xmpSegment(patched)) ?? xmpSegment(freshXmp(merged));
  if (at >= 0) headers[at] = xmp!;
  else headers.splice(metadataInsertIndex(headers), 0, xmp!);

  const iim = iptcSegment(merged);
  if (iim) headers.splice(metadataInsertIndex(headers), 0, iim);
  return buildJpeg(headers, parsed.scan, parsed.trailer);
}

/** Creator and copyright as a reader would see them: XMP first, then IPTC. For verification. */
export function readCredit(jpeg: Uint8Array): Credit {
  const parsed = parseJpeg(jpeg);
  const xmp = parsed?.headers.find(isXmpSegment);
  const text = xmp ? xmpText(xmp) : "";
  const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const creator = /<dc:creator>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(text)?.[1];
  const copyright = /<dc:rights>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(text)?.[1];
  const iptc = readIptc(jpeg);
  return { creator: creator !== undefined ? unescape(creator) : iptc.creator, copyright: copyright !== undefined ? unescape(copyright) : iptc.copyright };
}
