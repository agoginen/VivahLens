import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import jpeg from "jpeg-js";
import { readExif } from "@vivahlens/ingest";
import { afterAll, describe, expect, it } from "vitest";
import { injectCredit, readCredit } from "./credit.js";
import { applyWatermark, finishFile, finishJpeg, loadWatermark } from "./finishExport.js";
import { scrubGps } from "./gps.js";
import { injectIptc, readIptc } from "./iptc.js";
import { isIccSegment, jpegSize, parseJpeg } from "./jpegSegments.js";
import { decodePng } from "./png.js";
import { freshXmp, isXmpSegment, scrubXmpGps, setXmpCredit } from "./xmp.js";
import { app, contains, exifApp, GPS_MARKER, ifd0, OTHER_MARKER, scanHex, solidJpeg, tiffWithGps, withSegments, xmpApp, xmpOf } from "./testing/fixtures.js";
import { writeZip } from "./zip.js";

// ---------- helpers ----------

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

/** Encodes raw (unfiltered) rows into a PNG, applying the requested filter type to each row. */
function encodePng(opts: { width: number; height: number; colorType: number; depth: number; rows: Buffer[]; filters?: number[]; palette?: Buffer; trns?: Buffer; interlace?: number }): Buffer {
  const { width, height, colorType, depth, rows } = opts;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]!;
  const bpp = Math.max(1, (channels * depth) >> 3);
  const out: Buffer[] = [];
  rows.forEach((row, y) => {
    const f = opts.filters?.[y] ?? 0;
    const prev = rows[y - 1] ?? Buffer.alloc(row.length);
    const filtered = Buffer.alloc(row.length + 1);
    filtered[0] = f;
    for (let x = 0; x < row.length; x++) {
      const [a, b, c] = [x >= bpp ? row[x - bpp]! : 0, prev[x]!, x >= bpp ? prev[x - bpp]! : 0];
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][f]!;
      filtered[x + 1] = (row[x]! - pred) & 255;
    }
    out.push(filtered);
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[12] = opts.interlace ?? 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(opts.palette ? [chunk("PLTE", opts.palette)] : []),
    ...(opts.trns ? [chunk("tRNS", opts.trns)] : []),
    chunk("IDAT", deflateSync(Buffer.concat(out))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const dir = mkdtempSync(path.join(tmpdir(), "vivah-delivery-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ---------- PNG ----------

describe("decodePng", () => {
  it("round-trips RGBA through every filter type", () => {
    const w = 5;
    const rows = Array.from({ length: 5 }, (_, y) => Buffer.from(Array.from({ length: w * 4 }, (_, i) => (i * 37 + y * 91 + (i % 4 === 3 ? 100 : 0)) & 255)));
    const png = encodePng({ width: w, height: 5, colorType: 6, depth: 8, rows, filters: [0, 1, 2, 3, 4] });
    const img = decodePng(png);
    expect([img.width, img.height]).toEqual([5, 5]);
    expect(Buffer.from(img.data).equals(Buffer.concat(rows))).toBe(true);
  });

  it("expands palette images with transparency and sub-byte depths", () => {
    const palette = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    // 4-bit indices: row of 4 pixels 0,1,2,1 = bytes 0x01 0x21.
    const pal = decodePng(encodePng({ width: 4, height: 1, colorType: 3, depth: 4, rows: [Buffer.from([0x01, 0x21])], palette, trns: Buffer.from([128]) }));
    expect(Array.from(pal.data)).toEqual([255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255]);

    // 1-bit grayscale: 10100000 -> white, black, white, black.
    const gray = decodePng(encodePng({ width: 4, height: 1, colorType: 0, depth: 1, rows: [Buffer.from([0b10100000])] }));
    expect(Array.from(gray.data)).toEqual([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  });

  it("reads 16-bit RGB and gray+alpha", () => {
    const rgb16 = decodePng(encodePng({ width: 1, height: 1, colorType: 2, depth: 16, rows: [Buffer.from([0x80, 0x01, 0x40, 0xff, 0xff, 0x00])] }));
    expect(Array.from(rgb16.data)).toEqual([0x80, 0x40, 0xff, 255]);
    const ga = decodePng(encodePng({ width: 2, height: 1, colorType: 4, depth: 8, rows: [Buffer.from([10, 200, 30, 0])] }));
    expect(Array.from(ga.data)).toEqual([10, 10, 10, 200, 30, 30, 30, 0]);
  });

  it("rejects files it cannot read safely", () => {
    const ok = encodePng({ width: 1, height: 1, colorType: 6, depth: 8, rows: [Buffer.from([1, 2, 3, 4])] });
    expect(() => decodePng(Buffer.from("not a png at all, just text that is long enough to pass the size check"))).toThrow(/Not a PNG/);
    const corrupt = Buffer.from(ok);
    corrupt[corrupt.length - 20] ^= 0xff;
    expect(() => decodePng(corrupt)).toThrow(/corrupt/);
    expect(() => decodePng(ok.subarray(0, ok.length - 15))).toThrow(/truncated|corrupt|header/);
    expect(() => decodePng(encodePng({ width: 1, height: 1, colorType: 6, depth: 8, rows: [Buffer.from([1, 2, 3, 4])], interlace: 1 }))).toThrow(/Interlaced/);
  });

  it("refuses hostile files before allocating: oversized headers and image data that inflates beyond the header", () => {
    // 70 000 × 1 000 pixels declared, a few bytes of data.
    expect(() => decodePng(encodePng({ width: 70_000, height: 1_000, colorType: 6, depth: 8, rows: [Buffer.alloc(8)] }))).toThrow(/too large for a logo/);
    // A 4×1 header whose ten-megabyte zlib stream compresses to a few kilobytes.
    const bomb = encodePng({ width: 4, height: 1, colorType: 6, depth: 8, rows: [Buffer.alloc(10_000_000)] });
    expect(bomb.length).toBeLessThan(50_000);
    expect(() => decodePng(bomb)).toThrow(/corrupt or larger than its header/);
  });
});

// ---------- GPS ----------

describe("scrubGps", () => {
  const base = solidJpeg(16, 16, [120, 120, 120]);

  it.each([
    ["little-endian", true],
    ["big-endian", false],
  ])("erases the location block of a %s Exif segment, deletes its IFD0 entry, and keeps the camera data", (_n, little) => {
    const input = withSegments(base, [exifApp(tiffWithGps(little, 6))]);
    const before = Buffer.from(input);
    expect(contains(input, GPS_MARKER)).toBe(true);
    expect(ifd0(input).tags).toEqual([0x010f, 0x8825, 0x0112]);

    const { data, removed } = scrubGps(input);
    expect(removed).toBe(true);
    expect(contains(data, GPS_MARKER)).toBe(false);
    expect(contains(data, OTHER_MARKER)).toBe(false);
    // The pointer is gone (not retargeted) and later entries moved up. The link to the thumbnail IFD, which sat after
    // the last entry and moved with them, is cut as well: the thumbnail is removed with the location.
    expect(ifd0(data)).toEqual({ tags: [0x010f, 0x0112], next: 0 });
    expect(readExif(data)).toMatchObject({ make: "Canon", orientation: 6 });
    expect(() => jpeg.decode(Buffer.from(data))).not.toThrow();
    expect(scanHex(data)).toBe(scanHex(input));
    // The input buffer itself is never modified.
    expect(Buffer.from(input).equals(before)).toBe(true);
  });

  it("cuts only the GPS properties out of XMP (attribute and element form), keeping keywords and other data", () => {
    const xmp =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="r"><rdf:Description rdf:about="" xmlns:exif="e" xmlns:dc="d" exif:GPSLatitude="12,34.5N" exif:GPSVersionID="2.3.0.0" exif:ISOSpeed="400">' +
      "<exif:GPSLongitude>77,1.2E</exif:GPSLongitude><exif:GPSAltitude/><dc:subject><rdf:Bag><rdf:li>wedding</rdf:li></rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta>";
    const r = scrubGps(withSegments(base, [xmpApp(xmp)]));
    const out = xmpOf(r.data)!;
    expect(r.removed).toBe(true);
    expect(out).not.toMatch(/GPS/);
    expect(out).toContain("<rdf:li>wedding</rdf:li>");
    expect(out).toContain('exif:ISOSpeed="400"');
    expect(out).toContain('xmlns:exif="e"');
  });

  it("drops XMP it cannot check (UTF-16), plus extended XMP, and says so; leaves clean files and non-JPEGs untouched", () => {
    const utf16 = withSegments(base, [app(0xe1, Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), Buffer.from('<x:xmpmeta exif:GPSLatitude="1"/>', "utf16le")]))]);
    const dropped = scrubGps(utf16);
    // Nothing could be read, so nothing is claimed as found: it is reported as dropped instead.
    expect(dropped).toMatchObject({ removed: false, dropped: ["unreadable XMP packet"] });
    expect(xmpOf(dropped.data)).toBeUndefined();

    const extended = withSegments(base, [app(0xe1, Buffer.concat([Buffer.from("http://ns.adobe.com/xmp/extension/\0", "latin1"), Buffer.from("00112233445566778899aabbccddeeff....")]))]);
    expect(scrubGps(extended)).toMatchObject({ removed: false, dropped: ["extended XMP block"] });
    expect(Buffer.from(scrubGps(extended).data).includes("xmp/extension")).toBe(false);

    const keywords = withSegments(base, [xmpApp("<x:xmpmeta><dc:subject>wedding</dc:subject></x:xmpmeta>")]);
    const kept = scrubGps(keywords);
    expect(kept).toMatchObject({ removed: false, dropped: [] });
    expect(kept.data).toBe(keywords);

    expect(scrubGps(base)).toEqual({ data: base, removed: false, dropped: [] });
    const notJpeg = Buffer.from("not a jpeg");
    expect(scrubGps(notJpeg)).toEqual({ data: notJpeg, removed: false, dropped: [] });
  });

  it("never leaves an Exif block it cannot parse behind: it is dropped and reported, not trusted", () => {
    const badOrder = tiffWithGps(true);
    badOrder.write("XX", 0, "ascii"); // neither II nor MM
    const a = scrubGps(withSegments(base, [exifApp(badOrder)]));
    expect(a).toMatchObject({ removed: false, dropped: ["unreadable Exif block"] });
    expect(parseJpeg(a.data)!.headers.some((h) => h.marker === 0xe1)).toBe(false);

    const hugeCount = tiffWithGps(true);
    hugeCount.writeUInt16LE(60000, 8); // entry table would run far past the segment
    expect(scrubGps(withSegments(base, [exifApp(hugeCount)])).dropped).toEqual(["unreadable Exif block"]);

    const noGpsAtAll = tiffWithGps(true);
    noGpsAtAll.writeUInt16LE(0x0132, 22); // the GPS pointer becomes a DateTime entry
    expect(scrubGps(withSegments(base, [exifApp(noGpsAtAll)]))).toMatchObject({ removed: false, dropped: [] });
  });

  it("copes with a GPS pointer that points outside the segment", () => {
    const tiff = tiffWithGps(true);
    tiff.writeUInt32LE(0xfffffff0, 30); // value of the GPS pointer entry
    const r = scrubGps(withSegments(base, [exifApp(tiff)]));
    expect(r.removed).toBe(true);
    expect(ifd0(r.data).tags).toEqual([0x010f, 0x0112]);
  });
});

// ---------- IPTC ----------

describe("injectIptc", () => {
  const base = solidJpeg(16, 16, [10, 200, 90]);

  it("writes copyright and creator (UTF-8), replaces them on a second call, and leaves the pixels alone", () => {
    const once = injectIptc(base, { copyright: "© 2026 Ananya Rao Photography", creator: "Ananya Rao" });
    expect(readIptc(once)).toEqual({ copyright: "© 2026 Ananya Rao Photography", creator: "Ananya Rao" });
    expect(scanHex(once)).toBe(scanHex(base));
    expect(() => jpeg.decode(Buffer.from(once))).not.toThrow();

    const twice = injectIptc(once, { copyright: "© 2027 अनन्या राव" });
    expect(readIptc(twice)).toEqual({ copyright: "© 2027 अनन्या राव" });
    expect(parseJpeg(twice)!.headers.filter((h) => h.marker === 0xed)).toHaveLength(1);
  });

  it("keeps Exif first, respects IPTC length limits without splitting characters, and does nothing without fields", () => {
    const exif = withSegments(base, [exifApp(tiffWithGps(true))]);
    const out = injectIptc(exif, { creator: "é".repeat(40), copyright: "x".repeat(300) });
    const markers = parseJpeg(out)!.headers.map((h) => h.marker);
    expect(markers.indexOf(0xe1)).toBeLessThan(markers.indexOf(0xed));
    const fields = readIptc(out);
    expect(Buffer.byteLength(fields.creator!)).toBeLessThanOrEqual(32);
    expect(fields.creator).toBe("é".repeat(16));
    expect(fields.copyright).toHaveLength(128);

    expect(injectIptc(base, {})).toBe(base);
    expect(injectIptc(Buffer.from("junk"), { creator: "x" })).toEqual(Buffer.from("junk"));
    expect(readIptc(base)).toEqual({});
  });
});

// ---------- credit: IPTC + XMP ----------

/** Rough well-formedness check: tags nest properly (processing instructions ignored). */
function wellFormed(xml: string): boolean {
  const stack: string[] = [];
  for (const m of xml.replace(/<\?[\s\S]*?\?>/g, "").matchAll(/<(\/?)([A-Za-z_][\w.:-]*)(?:"[^"]*"|'[^']*'|[^>"'])*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m;
    if (selfClosing) continue;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else stack.push(name!);
  }
  return stack.length === 0;
}

const RDF_OPEN = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">';
const RDF_CLOSE = "</rdf:RDF></x:xmpmeta>";

describe("injectCredit", () => {
  const base = solidJpeg(16, 16, [10, 200, 90]);

  it("writes the credit as XMP and IPTC into a file with no metadata, escaping markup", () => {
    const out = injectCredit(base, { copyright: "© 2026 A & B <Studio>", creator: 'Ananya "Ani" Rao' });
    expect(readCredit(out)).toEqual({ copyright: "© 2026 A & B <Studio>", creator: 'Ananya "Ani" Rao' });
    expect(readIptc(out).creator).toBe('Ananya "Ani" Rao');
    expect(xmpOf(out)).toContain("A &amp; B &lt;Studio&gt;");
    expect(wellFormed(xmpOf(out)!)).toBe(true);
    expect(scanHex(out)).toBe(scanHex(base));
    expect(() => jpeg.decode(Buffer.from(out))).not.toThrow();
  });

  it("edits an existing packet in place: replaces dc:rights, keeps keywords, adds nothing twice", () => {
    const xmp =
      `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>${RDF_OPEN}<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
      '<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">old notice</rdf:li></rdf:Alt></dc:rights><dc:subject><rdf:Bag><rdf:li>wedding</rdf:li></rdf:Bag></dc:subject>' +
      `</rdf:Description>${RDF_CLOSE}<?xpacket end="w"?>`;
    const out = injectCredit(withSegments(base, [xmpApp(xmp)]), { copyright: "© new", creator: "Me" });
    const text = xmpOf(out)!;
    expect(text).not.toContain("old notice");
    expect(text).toContain("<rdf:li>wedding</rdf:li>");
    expect(text.match(/xmlns:dc=/g)).toHaveLength(1);
    expect(text.match(/<dc:rights>/g)).toHaveLength(1);
    expect(text.startsWith("<?xpacket")).toBe(true);
    expect(wellFormed(text)).toBe(true);
    expect(readCredit(out)).toEqual({ copyright: "© new", creator: "Me" });
    expect(parseJpeg(out)!.headers.filter(isXmpSegment)).toHaveLength(1);
  });

  it("declares the namespace and expands a self-closing description when needed", () => {
    const xmp = `${RDF_OPEN}<rdf:Description rdf:about="" xmlns:exif="e" exif:ISOSpeed="400"/>${RDF_CLOSE}`;
    const patched = setXmpCredit(xmp, { creator: "Me" })!;
    expect(patched).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"');
    expect(patched).toContain('exif:ISOSpeed="400"');
    expect(wellFormed(patched)).toBe(true);
    expect(patched).toContain("<dc:creator><rdf:Seq><rdf:li>Me</rdf:li></rdf:Seq></dc:creator></rdf:Description>");
  });

  it("only touches the fields it was given, including dc properties written as attributes", () => {
    const xmp = `${RDF_OPEN}<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" dc:rights="x"><dc:creator><rdf:Seq><rdf:li>Old Name</rdf:li></rdf:Seq></dc:creator></rdf:Description>${RDF_CLOSE}`;
    const onlyCreator = setXmpCredit(xmp, { creator: "New" })!;
    expect(onlyCreator).toContain('dc:rights="x"');
    expect(onlyCreator).not.toContain("Old Name");
    const onlyRights = setXmpCredit(xmp, { copyright: "© y" })!;
    expect(onlyRights).not.toContain('dc:rights="x"');
    expect(onlyRights).toContain("Old Name");
    expect(wellFormed(onlyRights)).toBe(true);
  });

  it("replaces a packet it cannot edit safely with a credit-only one", () => {
    const foreign = `${RDF_OPEN}<rdf:Description xmlns:dc="urn:other"/>${RDF_CLOSE}`;
    expect(setXmpCredit(foreign, { creator: "Me" })).toBeUndefined();
    expect(setXmpCredit("<x/>", { creator: "Me" })).toBeUndefined();
    expect(setXmpCredit("<\0x\0>\0", { creator: "Me" })).toBeUndefined();

    const out = injectCredit(withSegments(base, [xmpApp(foreign)]), { creator: "Me" });
    expect(readCredit(out)).toEqual({ creator: "Me" });
    expect(parseJpeg(out)!.headers.filter(isXmpSegment)).toHaveLength(1);
    expect(wellFormed(freshXmp({ creator: "A", copyright: "B" }))).toBe(true);
  });

  it("keeps the other IPTC field when only one is supplied, ignores blank input, and leaves non-JPEGs alone", () => {
    const first = injectCredit(base, { copyright: "© 2026 Me", creator: "Me" });
    const second = injectCredit(first, { creator: "New Name" });
    expect(readIptc(second)).toEqual({ creator: "New Name", copyright: "© 2026 Me" });
    expect(readCredit(second)).toEqual({ creator: "New Name", copyright: "© 2026 Me" });
    expect(parseJpeg(second)!.headers.filter((h) => h.marker === 0xed)).toHaveLength(1);

    expect(injectCredit(base, { creator: "  ", copyright: "" })).toBe(base);
    expect(injectCredit(Buffer.from("junk"), { creator: "x" })).toEqual(Buffer.from("junk"));
  });

  it("keeps Exif ahead of the new segments", () => {
    const out = injectCredit(withSegments(base, [exifApp(tiffWithGps(true))]), { creator: "Me" });
    const markers = parseJpeg(out)!.headers.map((h) => h.marker);
    expect(markers.indexOf(0xe1)).toBeLessThan(markers.lastIndexOf(0xe1));
    expect(readExif(out).make).toBe("Canon");
  });
});

describe("scrubXmpGps", () => {
  it("leaves text without GPS properties exactly as it was", () => {
    const clean = "<x:xmpmeta><dc:subject>GPS tips</dc:subject></x:xmpmeta>";
    expect(scrubXmpGps(clean)).toEqual({ xml: clean, removed: false, clean: true, unreadable: false });
    expect(scrubXmpGps('<a exif:GPSLatitude="1" b:GPSMapDatum=\'WGS-84\'/>')).toMatchObject({ removed: true, clean: true });
  });

  it("also removes GPS elements written in a default namespace, which carry no prefix", () => {
    const xml = '<rdf:Description xmlns="http://ns.adobe.com/exif/1.0/"><GPSLatitude>12,34.5N</GPSLatitude><GPSLongitude>77,1.2E</GPSLongitude><ISOSpeed>400</ISOSpeed></rdf:Description>';
    const r = scrubXmpGps(xml);
    expect(r).toMatchObject({ removed: true, clean: true });
    expect(r.xml).not.toMatch(/12,34|77,1|GPS/);
    expect(r.xml).toContain("<ISOSpeed>400</ISOSpeed>");
  });

  it("reports an edit it cannot complete as not clean, so the packet is dropped instead of trusted", () => {
    // An opening tag with no matching close: the element cannot be cut out, but the leftover is detected.
    const broken = '<rdf:Description><exif:GPSLatitude>12,34.5N</rdf:Description>';
    expect(scrubXmpGps(broken).clean).toBe(false);
    const dropped = scrubGps(withSegments(solidJpeg(8, 8, [9, 9, 9]), [xmpApp(broken)]));
    expect(dropped.removed).toBe(true);
    expect(xmpOf(dropped.data)).toBeUndefined();
  });
});

// ---------- finishing a delivery file ----------

describe("finishJpeg", () => {
  it("resizes, applies EXIF orientation, drops camera metadata (including location) and writes the credit", () => {
    const rotated = withSegments(solidJpeg(80, 40, [200, 50, 50]), [exifApp(tiffWithGps(true, 6))]);
    const r = finishJpeg(rotated, { maxEdgePx: 40, copyright: "© Me" });
    const out = jpeg.decode(Buffer.from(r.data));
    expect([out.width, out.height]).toEqual([20, 40]); // 80x40 rotated upright (40x80) then fitted into 40
    expect(r).toMatchObject({ reencoded: true, locationRemoved: true });
    expect(readExif(r.data)).toEqual({});
    expect(contains(r.data, GPS_MARKER)).toBe(false);
    expect(readCredit(r.data).copyright).toBe("© Me");
  });

  it("keeps the colour profile when it re-encodes, and reports location only when the source had any", () => {
    const icc = app(0xe2, Buffer.concat([Buffer.from("ICC_PROFILE\0\x01\x01", "latin1"), Buffer.from("fake-profile-bytes")]));
    const r = finishJpeg(withSegments(solidJpeg(64, 32, [5, 6, 7]), [icc]), { maxEdgePx: 32 });
    const profiles = parseJpeg(r.data)!.headers.filter(isIccSegment);
    expect(profiles).toHaveLength(1);
    expect(Buffer.from(profiles[0]!.bytes).equals(icc)).toBe(true);
    expect(jpegSize(parseJpeg(r.data)!)).toEqual({ width: 32, height: 16 });
    expect(r).toMatchObject({ reencoded: true, locationRemoved: false });

    // Even with scrubbing switched off, a re-encode cannot carry location along.
    const located = finishJpeg(withSegments(solidJpeg(64, 32, [5, 6, 7]), [exifApp(tiffWithGps(true))]), { maxEdgePx: 32, scrubGps: false });
    expect(located).toMatchObject({ reencoded: true, locationRemoved: true });
    expect(contains(located.data, GPS_MARKER)).toBe(false);
  });

  it("does not re-encode a file that is already within the size ceiling", () => {
    const small = withSegments(solidJpeg(30, 20, [1, 2, 3]), [exifApp(tiffWithGps(true))]);
    const r = finishJpeg(small, { maxEdgePx: 2048 });
    expect(r).toMatchObject({ reencoded: false, locationRemoved: true });
    expect(scanHex(r.data)).toBe(scanHex(small));
    expect(readExif(r.data).make).toBe("Canon");
    expect(contains(r.data, GPS_MARKER)).toBe(false);
  });

  it("without a resize or watermark keeps the pixels and camera data but removes the location", () => {
    const input = withSegments(solidJpeg(32, 32, [90, 90, 200]), [exifApp(tiffWithGps(false))]);
    const r = finishJpeg(input, { creator: "Me" });
    expect(r).toMatchObject({ reencoded: false, locationRemoved: true });
    expect(scanHex(r.data)).toBe(scanHex(input));
    expect(readExif(r.data).make).toBe("Canon");
    expect(contains(r.data, GPS_MARKER)).toBe(false);
    expect(readCredit(r.data).creator).toBe("Me");

    const kept = finishJpeg(input, { scrubGps: false });
    expect(contains(kept.data, GPS_MARKER)).toBe(true);
    expect(kept.locationRemoved).toBe(false);
  });

  it("refuses data that is not a JPEG instead of passing it through unprocessed", () => {
    expect(() => finishJpeg(Buffer.from("nope, not a jpeg"))).toThrow(/Not a readable JPEG/);
  });

  it("places a PNG logo with opacity in the chosen corner and nowhere else", () => {
    const photo = solidJpeg(200, 100, [100, 100, 100], 100);
    const logo = encodePng({ width: 20, height: 10, colorType: 6, depth: 8, rows: Array.from({ length: 10 }, () => Buffer.from(Array.from({ length: 20 }, () => [255, 255, 255, 255]).flat())) });
    const plain = jpeg.decode(photo);
    const marked = jpeg.decode(Buffer.from(finishJpeg(photo, { watermark: { png: logo, position: "bottom-right", opacity: 1, widthRatio: 0.2 } }).data));
    const px = (img: { width: number; data: Uint8Array }, x: number, y: number) => img.data[(y * img.width + x) * 4]!;

    // 20% of 200 is 40px but the logo is only 20px wide and is never enlarged; bottom-right with a 4px margin.
    expect(px(marked, 200 - 4 - 10, 100 - 4 - 5)).toBeGreaterThan(220);
    expect(px(plain, 200 - 4 - 10, 100 - 4 - 5)).toBeLessThan(120);
    expect(px(marked, 10, 10)).toBeLessThan(120);
  });

  it("honours logo transparency and the opacity setting, and never enlarges a small logo", () => {
    const photo = { width: 100, height: 100, data: new Uint8Array(100 * 100 * 4).fill(100) };
    const solid = { width: 10, height: 10, data: new Uint8Array(10 * 10 * 4).fill(255) };
    const half = applyWatermark(photo, solid, { position: "top-left", opacity: 0.5, widthRatio: 0.5 });
    expect(half.data[(2 * 100 + 2) * 4]).toBe(Math.round(255 * 0.5 + 100 * 0.5));
    // Logo stays 10px wide even though 50% of the photo would be 50px.
    expect(half.data[(2 * 100 + 15) * 4]).toBe(100);

    const clear = { width: 10, height: 10, data: new Uint8Array(10 * 10 * 4) };
    expect(Array.from(applyWatermark(photo, clear).data)).toEqual(Array.from(photo.data));
    expect(applyWatermark(photo, solid, { opacity: 0 }).data).toEqual(photo.data);
  });

  it("keeps the transparent area of a down-scaled logo transparent (no opaque box around it)", () => {
    const px = new Uint8Array(40 * 40 * 4); // fully transparent black
    for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) px.set([255, 255, 255, 255], (y * 40 + x) * 4);
    const photo = { width: 100, height: 100, data: new Uint8Array(100 * 100 * 4).fill(100) };
    // 20% of 100px → the 40px logo is halved to 20px; 2px margin from the top-left corner.
    const out = applyWatermark(photo, { width: 40, height: 40, data: px }, { position: "top-left", opacity: 1, widthRatio: 0.2 });
    const at = (x: number, y: number) => out.data[(y * 100 + x) * 4];
    expect(at(2 + 10, 2 + 10)).toBe(255);
    expect(at(2 + 1, 2 + 1)).toBe(100);
    expect(at(2 + 19, 2 + 19)).toBe(100);
  });
});

describe("finishFile", () => {
  it("rewrites a JPEG in place, refuses other formats without touching them, and reports missing files", async () => {
    const file = path.join(dir, "photo.jpg");
    writeFileSync(file, withSegments(solidJpeg(64, 64, [1, 2, 3]), [exifApp(tiffWithGps(true))]));
    const r = await finishFile(file, file, { maxEdgePx: 32, copyright: "© Me" });
    expect(r).toMatchObject({ reencoded: true, locationRemoved: true, file });
    expect(jpeg.decode(readFileSync(file)).width).toBe(32);
    expect(readCredit(readFileSync(file)).copyright).toBe("© Me");

    const tif = path.join(dir, "print.tif");
    writeFileSync(tif, "II*\0 not touched");
    await expect(finishFile(tif, tif, { copyright: "© Me" })).rejects.toThrow(/not a JPEG/);
    expect(readFileSync(tif, "utf8")).toBe("II*\0 not touched");

    await expect(finishFile(path.join(dir, "missing.jpg"), path.join(dir, "out.jpg"))).rejects.toThrow(/ENOENT/);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("writes to another path and leaves the source exactly as it was", async () => {
    const source = path.join(dir, "original.jpeg");
    const original = withSegments(solidJpeg(20, 20, [9, 9, 9]), [exifApp(tiffWithGps(false))]);
    writeFileSync(source, original);
    const copy = path.join(dir, "delivered.jpeg");
    await finishFile(source, copy, { creator: "Me" });
    expect(readFileSync(source).equals(original)).toBe(true);
    expect(contains(readFileSync(copy), GPS_MARKER)).toBe(false);
    expect(readCredit(readFileSync(copy)).creator).toBe("Me");
  });

  it("leaves no partial file when the destination cannot be written", async () => {
    const source = path.join(dir, "src.jpg");
    writeFileSync(source, solidJpeg(8, 8, [1, 1, 1]));
    const blocked = path.join(dir, "blocked");
    mkdirSync(blocked);
    // Renaming a file over a directory fails after the temp file was written.
    await expect(finishFile(source, blocked, {})).rejects.toThrow();
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("loadWatermark", () => {
  it("returns the logo with its placement and rejects files that are not decodable PNGs, naming the file", async () => {
    const good = path.join(dir, "logo.png");
    writeFileSync(good, encodePng({ width: 1, height: 1, colorType: 6, depth: 8, rows: [Buffer.from([255, 255, 255, 255])] }));
    expect(await loadWatermark(good, { position: "top-left", opacity: 0.4 })).toMatchObject({ position: "top-left", opacity: 0.4 });

    const bad = path.join(dir, "not-a-logo.png");
    writeFileSync(bad, "plain text pretending to be a picture, long enough to be read");
    await expect(loadWatermark(bad)).rejects.toThrow(/not-a-logo\.png.*Not a PNG/);
    await expect(loadWatermark(path.join(dir, "absent.png"))).rejects.toThrow(/ENOENT/);
  });
});

// ---------- ZIP ----------

/** Independent reader: end record → central directory → local header, checking CRCs on the way. */
function readZip(file: string): Map<string, Buffer> {
  const b = readFileSync(file);
  const end = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = b.readUInt16LE(end + 10);
  let p = b.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(b.readUInt32LE(p)).toBe(0x02014b50);
    const crc = b.readUInt32LE(p + 16);
    const size = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const skip = b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.toString("utf8", p + 46, p + 46 + nameLen);
    expect(b.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const data = b.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    p += 46 + nameLen + skip;
  }
  return out;
}

describe("writeZip", () => {
  const files = (names: Record<string, Buffer>) => {
    const folder = mkdtempSync(path.join(dir, "zip-"));
    return Object.entries(names).map(([name, data]) => {
      const f = path.join(folder, name);
      writeFileSync(f, data);
      return f;
    });
  };

  it("stores every file under its own name, including non-ASCII ones, with correct CRCs", async () => {
    const inputs = files({ "b.jpg": Buffer.from("second file"), "a.jpg": Buffer.alloc(5000, 7), "été-नमस्ते.jpg": Buffer.from("unicode name"), "empty.jpg": Buffer.alloc(0) });
    const r = await writeZip({ files: inputs, outBase: path.join(dir, "all") });
    expect(r).toEqual({ archives: [path.join(dir, "all.zip")], entries: 4 });
    const zip = readZip(r.archives[0]!);
    expect([...zip.keys()].sort()).toEqual(["a.jpg", "b.jpg", "empty.jpg", "été-नमस्ते.jpg"]);
    expect(zip.get("a.jpg")!.equals(Buffer.alloc(5000, 7))).toBe(true);
    expect(zip.get("b.jpg")!.toString()).toBe("second file");
    expect(zip.get("empty.jpg")!.length).toBe(0);
  });

  it("splits into numbered parts when the size limit would be exceeded, never splitting a file", async () => {
    const inputs = files({ "1.jpg": Buffer.alloc(400, 1), "2.jpg": Buffer.alloc(400, 2), "3.jpg": Buffer.alloc(400, 3), "4.jpg": Buffer.alloc(2000, 4) });
    const r = await writeZip({ files: inputs, outBase: path.join(dir, "split"), maxPartBytes: 1100 });
    expect(r.archives.map((a) => path.basename(a))).toEqual(["split-part1.zip", "split-part2.zip", "split-part3.zip"]);
    expect(r.entries).toBe(4);
    const names = r.archives.map((a) => [...readZip(a).keys()]);
    expect(names).toEqual([["1.jpg", "2.jpg"], ["3.jpg"], ["4.jpg"]]);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses an empty set and cleans up if a file disappears", async () => {
    await expect(writeZip({ files: [], outBase: path.join(dir, "none") })).rejects.toThrow(/Nothing to pack/);
    const [keep, gone] = files({ "keep.jpg": Buffer.from("x"), "gone.jpg": Buffer.from("y") });
    rmSync(gone!);
    await expect(writeZip({ files: [keep!, gone!], outBase: path.join(dir, "broken") })).rejects.toThrow(/ENOENT/);
    expect(readdirSync(dir).filter((n) => n.startsWith("broken"))).toEqual([]);
  });
});
