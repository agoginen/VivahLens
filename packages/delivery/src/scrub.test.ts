import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { injectCredit, readCredit } from "./credit.js";
import { scrubGps } from "./gps.js";
import { readIptc } from "./iptc.js";
import { buildJpeg, parseJpeg } from "./jpegSegments.js";
import { scrubXmpGps, setXmpCredit } from "./xmp.js";
import {
  app,
  assembleTiff,
  contains,
  exifApp,
  exifTiff,
  GPS_MARKER,
  iccApp,
  ifd0,
  iim,
  marked,
  OTHER_MARKER,
  photoshopApp,
  scanHex,
  solidJpeg,
  tiffWithGps,
  withSegments,
  xmpApp,
  xmpOf,
  type IfdSpec,
} from "./testing/fixtures.js";

const base = solidJpeg(16, 16, [120, 120, 120]);
const EOI = Buffer.from([0xff, 0xd9]);

describe("parseJpeg: where the image ends", () => {
  // Header-only segments are fake: the parser looks at marker structure, not at what the tables say.
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  const dht = Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]);
  // Stuffed 0xFF00, a restart marker, fill bytes and another restart marker: none of them ends the scan.
  const entropy1 = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0xff, 0xff, 0xff, 0xd1, 0x9a]);
  const entropy2 = Buffer.from([0xbc, 0xff, 0x00, 0xde]);
  const head = [app(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")), app(0xc0, Buffer.alloc(15))];
  const body = Buffer.concat([sos, entropy1, dht, sos, entropy2, EOI]);
  const file = (trailer = "") => Buffer.concat([Buffer.from([0xff, 0xd8]), ...head, body, Buffer.from(trailer)]);

  it("walks through several scans and splits off whatever follows the end-of-image marker", () => {
    const parsed = parseJpeg(file("TRAILER-BYTES"))!;
    expect(parsed.headers.map((h) => h.marker)).toEqual([0xe0, 0xc0]);
    expect(Buffer.from(parsed.scan).equals(body)).toBe(true);
    expect(Buffer.from(parsed.trailer).toString()).toBe("TRAILER-BYTES");
    expect(parsed.scanSegments.map((s) => s.marker)).toEqual([0xc4, 0xda]);
    const table = parsed.scanSegments[0]!;
    expect(Buffer.from(parsed.scan.subarray(table.start, table.end)).equals(dht)).toBe(true);
    expect(Buffer.from(buildJpeg(parsed.headers, parsed.scan, parsed.trailer)).equals(file("TRAILER-BYTES"))).toBe(true);
  });

  it("has no trailer when the file ends at the end-of-image marker, and keeps everything when it is cut off", () => {
    expect(parseJpeg(file())!.trailer.length).toBe(0);
    const cut = file().subarray(0, file().length - 3); // inside the last scan, no end-of-image marker
    const parsed = parseJpeg(cut)!;
    expect(parsed.trailer.length).toBe(0);
    expect(parsed.scan.length).toBe(cut.length - 2 - head.reduce((n, h) => n + h.length, 0));
  });

  it("does not guess when the structure stops making sense: nothing is treated as a trailer", () => {
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8]), ...head, sos, entropy1, dht, Buffer.from([0x12, 0x34]), EOI, Buffer.from("MORE")]);
    const parsed = parseJpeg(broken)!;
    expect(parsed.trailer.length).toBe(0);
    expect(Buffer.from(parsed.scan).toString("latin1")).toContain("MORE");
  });
});

describe("scrubGps: only what is understood survives", () => {
  it("drops everything after the end of the image, such as a second JPEG with its own location, and says so", () => {
    const second = withSegments(base, [exifApp(tiffWithGps(true))]);
    const clean = scrubGps(Buffer.concat([base, second]));
    expect(contains(clean.data, GPS_MARKER)).toBe(false);
    expect(clean).toMatchObject({ removed: false, dropped: ["trailing data"] });
    expect(Buffer.from(clean.data).equals(base)).toBe(true);

    const both = scrubGps(Buffer.concat([second, second]));
    expect(contains(both.data, GPS_MARKER)).toBe(false);
    expect(both).toMatchObject({ removed: true, dropped: ["trailing data"] });
    expect(() => jpeg.decode(Buffer.from(both.data))).not.toThrow();
  });

  it("removes padding after the image without calling it a loss", () => {
    const padded = Buffer.concat([base, Buffer.alloc(100), Buffer.from("\r\n  ")]);
    const r = scrubGps(padded);
    expect(r.dropped).toEqual([]);
    expect(Buffer.from(r.data).equals(base)).toBe(true);
  });

  it("drops vendor blocks, comments and second-image headers but keeps JFIF, the colour profile and Adobe's colour flag", () => {
    const adobe = app(0xee, Buffer.from("Adobe\0\x64\x00\x00\x00\x00\x00\x01", "latin1"));
    const icc = iccApp();
    const unwanted = [
      app(0xe6, Buffer.from("GoPro\0GPS5 coordinates")),
      app(0xe3, Buffer.from("Meta\0\0location")),
      app(0xe2, Buffer.from("MPF\0multi-picture")),
      app(0xe0, Buffer.from("JFXX\0\x10thumbnail")),
      app(0xe1, Buffer.from("Other\0vendor data")),
      app(0xfe, Buffer.from("taken at the farm")),
      app(0xf4, Buffer.from("JPG4 extension")),
    ];
    const input = withSegments(base, [icc, adobe, ...unwanted]);
    const r = scrubGps(input);

    const kept = parseJpeg(r.data)!.headers.map((h) => h.marker);
    expect(kept.filter((m) => m === 0xe0)).toHaveLength(1); // jpeg-js's JFIF only
    expect(Buffer.from(parseJpeg(r.data)!.headers.find((h) => h.marker === 0xee)!.bytes).equals(adobe)).toBe(true);
    expect(Buffer.from(parseJpeg(r.data)!.headers.find((h) => h.marker === 0xe2)!.bytes).equals(icc)).toBe(true);
    for (const marker of [0xe1, 0xe3, 0xe6, 0xf4, 0xfe]) expect(kept).not.toContain(marker);
    expect(r.dropped.sort()).toEqual(["APP0 block", "APP1 block", "APP2 block", "APP3 block", "APP6 block", "JPEG extension block", "comment"].sort());
    expect(scanHex(r.data)).toBe(scanHex(input));
    expect(() => jpeg.decode(Buffer.from(r.data))).not.toThrow();
  });

  it("cuts metadata hidden between scans, not only before the first one", () => {
    const hidden = Buffer.concat([base.subarray(0, base.length - 2), exifApp(tiffWithGps(true)), app(0xe6, Buffer.from("GoPro\0GPS5")), EOI]);
    expect(parseJpeg(hidden)!.scanSegments.map((s) => s.marker)).toEqual([0xe1, 0xe6]);
    const r = scrubGps(hidden);
    expect(contains(r.data, GPS_MARKER)).toBe(false);
    expect(Buffer.from(r.data).includes("GoPro")).toBe(false);
    expect(r).toMatchObject({ removed: true, dropped: ["APP6 block"] });
    // The Exif block stays (camera data) but without its location; the vendor block is gone.
    expect(parseJpeg(r.data)!.scanSegments.map((s) => s.marker)).toEqual([0xe1]);
    expect(scanHex(r.data).startsWith(scanHex(base).slice(0, 40))).toBe(true);
  });

  describe("Photoshop blocks", () => {
    const iptc = (data = iim({ creator: "Me", copyright: "© Me" })) => ({ id: 0x0404, data });

    it("are reduced to their IPTC fields: a second Exif block, alternative XMP and thumbnails do not survive", () => {
      const block = photoshopApp([
        { id: 0x03ed, data: Buffer.alloc(16) },
        iptc(),
        { id: 0x0422, data: marked(GPS_MARKER, 16) },
        { id: 0x0424, data: Buffer.from('<x:xmpmeta exif:GPSLatitude="1"/>') },
        { id: 0x040c, data: marked(OTHER_MARKER, 20) },
      ]);
      const r = scrubGps(withSegments(base, [block]));
      expect(contains(r.data, GPS_MARKER)).toBe(false);
      expect(contains(r.data, OTHER_MARKER)).toBe(false);
      expect(readIptc(r.data)).toEqual({ creator: "Me", copyright: "© Me" });
      expect(parseJpeg(r.data)!.headers.filter((h) => h.marker === 0xed)).toHaveLength(1);
    });

    it("are left exactly as they are when they hold nothing but IPTC, and dropped quietly when they hold none", () => {
      const only = withSegments(base, [photoshopApp([iptc()])]);
      expect(scrubGps(only).data).toBe(only);

      const none = scrubGps(withSegments(base, [photoshopApp([{ id: 0x0422, data: marked(GPS_MARKER, 16) }])]));
      expect(none.dropped).toEqual([]);
      expect(parseJpeg(none.data)!.headers.some((h) => h.marker === 0xed)).toBe(false);
      expect(contains(none.data, GPS_MARKER)).toBe(false);
    });

    it("keep their IPTC when a later resource is malformed, and discard what cannot be read", () => {
      const good = photoshopApp([iptc()]);
      const broken = Buffer.concat([good, Buffer.from("8BIM"), Buffer.from([0x04, 0x22, 0, 0, 0x7f, 0xff, 0xff, 0xff]), marked(GPS_MARKER, 16)]);
      // Re-wrap: the extra bytes belong to the same APP13 payload.
      const payload = broken.subarray(4);
      const r = scrubGps(withSegments(base, [app(0xed, payload)]));
      expect(readIptc(r.data).creator).toBe("Me");
      expect(contains(r.data, GPS_MARKER)).toBe(false);
    });
  });
});

describe("scrubGps: Exif structure", () => {
  const make = { tag: 0x010f, type: 2, count: 6, value: Buffer.from("Canon\0") };
  const gpsIfd = (marker: number, type = 5, count = 3, size = 24): IfdSpec => ({ fields: [{ tag: 0x0002, type, count, value: marked(marker, size) }] });
  const withExif = (tiff: Buffer) => withSegments(base, [exifApp(tiff)]);

  it("removes every GPS pointer in IFD0, not just the first", () => {
    const tiff = assembleTiff([
      { fields: [make, { tag: 0x8825, type: 4, count: 1, value: { ifd: 1 } }, { tag: 0x8825, type: 4, count: 1, value: { ifd: 2 } }, { tag: 0x0112, type: 3, count: 1, value: 6 }] },
      gpsIfd(GPS_MARKER),
      gpsIfd(OTHER_MARKER),
    ]);
    const r = scrubGps(withExif(tiff));
    expect(r.removed).toBe(true);
    expect(contains(r.data, GPS_MARKER) || contains(r.data, OTHER_MARKER)).toBe(false);
    expect(ifd0(r.data).tags).toEqual([0x010f, 0x0112]);
  });

  it("finds a GPS pointer inside the Exif sub-IFD and inside SubIFDs", () => {
    const viaExifIfd = assembleTiff([
      { fields: [make, { tag: 0x8769, type: 4, count: 1, value: { ifd: 1 } }] },
      { fields: [{ tag: 0x9003, type: 2, count: 20, value: Buffer.from("2026:01:01 10:00:00\0") }, { tag: 0x8825, type: 4, count: 1, value: { ifd: 2 } }] },
      gpsIfd(GPS_MARKER),
    ]);
    const a = scrubGps(withExif(viaExifIfd));
    expect(a.removed).toBe(true);
    expect(contains(a.data, GPS_MARKER)).toBe(false);

    const viaSubIfds = assembleTiff([
      { fields: [make, { tag: 0x014a, type: 4, count: 2, value: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]) }] },
      gpsHolder(),
    ]);
    // The offset array points at a plain IFD that itself carries a GPS pointer.
    function gpsHolder(): IfdSpec {
      return { fields: [{ tag: 0x8825, type: 4, count: 1, value: { ifd: 2 } }] };
    }
    expect(() => scrubGps(withExif(viaSubIfds))).not.toThrow();
  });

  it("zeroes out-of-line GPS values of every TIFF type, including the signed and floating-point ones", () => {
    const cases: [number, number, number][] = [
      [6, 8, 8], // SBYTE x 8
      [8, 3, 6], // SSHORT x 3
      [11, 2, 8], // FLOAT x 2
      [12, 3, 24], // DOUBLE x 3
      [13, 2, 8], // IFD x 2
    ];
    for (const [type, count, size] of cases) {
      const tiff = assembleTiff([{ fields: [make, { tag: 0x8825, type: 4, count: 1, value: { ifd: 1 } }] }, gpsIfd(GPS_MARKER, type, count, size)]);
      expect(contains(withExif(tiff), GPS_MARKER)).toBe(true);
      expect(contains(scrubGps(withExif(tiff)).data, GPS_MARKER), `type ${type}`).toBe(false);
    }
  });

  describe("the embedded thumbnail", () => {
    const nested = withSegments(base, [exifApp(tiffWithGps(true))]); // a thumbnail that carries its own location
    const thumbFields = (extra: IfdSpec["fields"] = []) => [{ tag: 0x0201, type: 4, count: 1, value: { blob: nested } }, { tag: 0x0202, type: 4, count: 1, value: nested.length }, ...extra];

    it("is removed together with the location it carries, and the Exif block shrinks to match", () => {
      const tiff = assembleTiff([{ fields: [make, { tag: 0x0112, type: 3, count: 1, value: 6 }], next: 1 }, { fields: thumbFields() }]);
      const input = withExif(tiff);
      expect(contains(input, GPS_MARKER)).toBe(true);

      const r = scrubGps(input);
      expect(contains(r.data, GPS_MARKER)).toBe(false);
      expect(ifd0(r.data)).toEqual({ tags: [0x010f, 0x0112], next: 0 });
      expect(exifTiff(r.data)!.length).toBeLessThan(exifTiff(input)!.length - nested.length + 16);
      expect(() => jpeg.decode(Buffer.from(r.data))).not.toThrow();
      expect(scanHex(r.data)).toBe(scanHex(input));
    });

    it("is zeroed in place when other data follows it", () => {
      const tiff = assembleTiff([
        { fields: [make], next: 1 },
        { fields: thumbFields([{ tag: 0x0132, type: 2, count: 20, value: Buffer.from("2026:01:01 10:00:00\0") }]) },
      ]);
      const input = withExif(tiff);
      const r = scrubGps(input);
      expect(contains(r.data, GPS_MARKER)).toBe(false);
      expect(exifTiff(r.data)!.length).toBe(exifTiff(input)!.length);
      expect(ifd0(r.data).next).toBe(0);
    });

    it("has its own GPS pointers erased even when it is not a JPEG thumbnail", () => {
      const tiff = assembleTiff([{ fields: [make], next: 1 }, { fields: [{ tag: 0x8825, type: 4, count: 1, value: { ifd: 2 } }] }, gpsIfd(GPS_MARKER)]);
      expect(contains(scrubGps(withExif(tiff)).data, GPS_MARKER)).toBe(false);
    });
  });

  it("survives IFDs that point back at themselves, and keeps the camera data it can still read", () => {
    const loop = assembleTiff([{ fields: [make, { tag: 0x8825, type: 4, count: 1, value: { ifd: 1 } }], next: 0 }, gpsIfd(GPS_MARKER)]);
    const r = scrubGps(withExif(loop));
    expect(contains(r.data, GPS_MARKER)).toBe(false);
    expect(ifd0(r.data)).toEqual({ tags: [0x010f], next: 0 });
  });
});

/** A reader written separately from the code under test: could anything reachable from IFD0, IFD1 or the Exif IFD still show the marker? */
function reachableGps(tiff: Buffer): boolean {
  const order = tiff.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") return false;
  const little = order === "II";
  const u16 = (o: number) => (o >= 0 && o + 2 <= tiff.length ? (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)) : undefined);
  const u32 = (o: number) => (o >= 0 && o + 4 <= tiff.length ? (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)) : undefined);
  const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
  const holdsMarker = (ifd: number | undefined): boolean => {
    const n = ifd === undefined ? undefined : u16(ifd);
    if (ifd === undefined || n === undefined) return false;
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      const size = (SIZE[u16(e + 2) ?? 0] ?? 0) * (u32(e + 4) ?? 0);
      const at = size > 4 ? u32(e + 8) : e + 8;
      if (at !== undefined && contains(tiff.subarray(at, at + Math.min(size, 64)), GPS_MARKER)) return true;
    }
    return false;
  };
  const seen = new Set<number>();
  const walk = (ifd: number | undefined, depth: number): boolean => {
    const n = ifd === undefined ? undefined : u16(ifd);
    if (ifd === undefined || n === undefined || seen.has(ifd) || depth > 3) return false;
    seen.add(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      const tag = u16(e);
      if (tag === 0x8825 && holdsMarker(u32(e + 8))) return true;
      if (tag === 0x8769 && walk(u32(e + 8), depth + 1)) return true;
    }
    return walk(u32(ifd + 2 + n * 12), depth + 1);
  };
  return walk(u32(4), 0);
}

describe("scrubGps: mutated Exif blocks", () => {
  it("never lets a reader reach location data in anything it returns, and never throws", () => {
    const make = { tag: 0x010f, type: 2, count: 6, value: Buffer.from("Canon\0") };
    const gps = (marker: number): IfdSpec => ({ fields: [{ tag: 0x0002, type: 5, count: 3, value: marked(marker, 24) }] });
    const fixtures = [
      tiffWithGps(true),
      tiffWithGps(false),
      assembleTiff([{ fields: [make, { tag: 0x8769, type: 4, count: 1, value: { ifd: 1 } }, { tag: 0x8825, type: 4, count: 1, value: { ifd: 2 } }], next: 3 }, { fields: [{ tag: 0x8825, type: 4, count: 1, value: { ifd: 2 } }] }, gps(GPS_MARKER), { fields: [{ tag: 0x8825, type: 4, count: 1, value: { ifd: 2 } }] }]),
      assembleTiff([{ fields: [make, { tag: 0x8825, type: 4, count: 1, value: { ifd: 1 } }, { tag: 0x8825, type: 4, count: 1, value: { ifd: 1 } }] }, gps(GPS_MARKER)], false),
    ];
    // VIVAH_FUZZ_RUNS / VIVAH_FUZZ_SEED let a longer soak run be started on demand: VIVAH_FUZZ_RUNS=200000 npx vitest run ...
    const perFixture = Number(process.env.VIVAH_FUZZ_RUNS ?? 1500);
    let seed = Number(process.env.VIVAH_FUZZ_SEED ?? 20240607);
    const next = (n: number) => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed % n);

    let reachableBefore = 0;
    let runs = 0;
    const failures: { run: number; fixture: number; mutated: string; scrubbed: string }[] = [];
    for (const [index, tiff] of fixtures.entries()) {
      for (let n = 0; n < perFixture; n++) {
        const mutated = Buffer.from(tiff);
        for (let flips = 1 + next(4); flips > 0; flips--) mutated[next(mutated.length)] = next(4) === 0 ? 0 : next(256);
        runs++;
        if (reachableGps(mutated)) reachableBefore++;
        const after = exifTiff(scrubGps(withSegments(base, [exifApp(mutated)])).data);
        if (after !== undefined && reachableGps(after) && failures.length < 3) {
          failures.push({ run: runs, fixture: index, mutated: mutated.toString("hex"), scrubbed: after.toString("hex") });
        }
      }
    }
    expect(failures).toEqual([]);
    // The test only means something if many of the inputs really did expose location.
    expect(reachableBefore).toBeGreaterThan(runs * 0.2);
  });
});

describe("credit and IPTC robustness", () => {
  it("never cuts a character in half when shortening to the IPTC byte limits", () => {
    // 29 bytes plus a 4-byte emoji does not fit in 32: the emoji goes, whole.
    const long = injectCredit(base, { creator: `${"x".repeat(29)}😀` });
    expect(readIptc(long).creator).toBe("x".repeat(29));
    expect(readIptc(long).creator).not.toContain("\uFFFD");
    // XMP is not limited that way and keeps the whole name.
    expect(readCredit(long).creator).toBe(`${"x".repeat(29)}😀`);

    expect(readIptc(injectCredit(base, { creator: "😀".repeat(9) })).creator).toBe("😀".repeat(8));
    expect(readIptc(injectCredit(base, { creator: "é".repeat(16) })).creator).toBe("é".repeat(16));
  });

  it("does not choke on a Photoshop block with malformed resources", () => {
    const longName = app(0xed, Buffer.concat([Buffer.from("Photoshop 3.0\0", "latin1"), Buffer.from("8BIM"), Buffer.from([0x04, 0x04, 0xff, 0x00]), Buffer.alloc(8)]));
    const hugeSize = app(0xed, Buffer.concat([Buffer.from("Photoshop 3.0\0", "latin1"), Buffer.from("8BIM"), Buffer.from([0x04, 0x04, 0x00, 0x00, 0xff, 0xff, 0xff, 0xf0]), Buffer.alloc(8)]));
    const shortSet = photoshopApp([{ id: 0x0404, data: Buffer.from([0x1c, 2, 80, 0x7f, 0xff, 0x41]) }]); // data set claims 32 KB
    for (const block of [longName, hugeSize, shortSet]) {
      const input = withSegments(base, [block]);
      expect(readIptc(input)).toEqual({});
      expect(() => injectCredit(input, { creator: "Me" })).not.toThrow();
      expect(readCredit(injectCredit(input, { creator: "Me" })).creator).toBe("Me");
    }
  });
});

describe("XMP editing stays fast on hostile input", () => {
  it("handles a 64 KB run of whitespace in linear time (a leading \\s+ made it quadratic)", () => {
    const spaces = " ".repeat(64_000);
    const started = performance.now();
    scrubXmpGps(`<rdf:Description${spaces}x:GPSLatitude`);
    setXmpCredit(`<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"${spaces}dc:creator`, { creator: "Me" });
    setXmpCredit(`<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"${spaces}dc:rights`, { copyright: "x" });
    // The quadratic version took seconds for each of these calls; a busy machine must not fail the linear one.
    expect(performance.now() - started).toBeLessThan(2000);

    // And the edit is still right when whitespace is where it normally is.
    const edited = scrubGps(withSegments(base, [xmpApp('<rdf:Description  xmlns:exif="e"\n   exif:GPSLatitude="1"\n   exif:ISOSpeed="400"/>')]));
    expect(xmpOf(edited.data)).toContain('exif:ISOSpeed="400"');
    expect(xmpOf(edited.data)).not.toContain("GPS");
  });
});
