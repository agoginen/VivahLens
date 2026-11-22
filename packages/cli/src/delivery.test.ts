import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import jpeg from "jpeg-js";
import { afterAll, describe, expect, it } from "vitest";
import type { ProcessRunner } from "@vivahlens/core";
import { runCli } from "./commands.js";

const SECRET = "GPS-SECRET-PLACE";

/** Little-endian TIFF with Make and a GPS IFD whose single value is a recognisable string. */
function exifWithGps(): Buffer {
  const b = Buffer.alloc(80);
  b.write("II", 0, "ascii");
  b.writeUInt16LE(42, 2);
  b.writeUInt32LE(8, 4);
  b.writeUInt16LE(2, 8);
  b.writeUInt16LE(0x010f, 10), b.writeUInt16LE(2, 12), b.writeUInt32LE(6, 14), b.writeUInt32LE(38, 18);
  b.writeUInt16LE(0x8825, 22), b.writeUInt16LE(4, 24), b.writeUInt32LE(1, 26), b.writeUInt32LE(44, 30);
  b.write("Canon\0", 38, "latin1");
  b.writeUInt16LE(1, 44);
  b.writeUInt16LE(0x001b, 46), b.writeUInt16LE(2, 48), b.writeUInt32LE(SECRET.length + 1, 50), b.writeUInt32LE(62, 54);
  b.write(`${SECRET}\0`, 62, "latin1");
  return b;
}

/** A textured JPEG with GPS in its Exif block. `variant` makes pictures differ so they are not duplicates. */
function located(w: number, h: number, variant = 0): Buffer {
  const data = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.fill(Math.min(255, 40 + (((variant ? w - 1 - x : x) / w) * 170 + ((x + y) % 2) * 50)), (y * w + x) * 4, (y * w + x) * 4 + 3);
  }
  const base = Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), exifWithGps()]);
  const segment = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
  return Buffer.concat([base.subarray(0, 2), segment, base.subarray(2)]);
}

/** Solid-colour RGBA PNG. */
function logoPng(w: number, h: number, rgba: [number, number, number, number]): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgba).flat())]);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const root = mkdtempSync(path.join(tmpdir(), "vivah-deliver-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const fresh = (name: string) => {
  const dir = path.join(root, `${name}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

function cli(args: string[], run?: ProcessRunner) {
  const all: string[] = [];
  const stdout: string[] = [];
  return runCli(args, { env: { VIVAH_HOME: path.join(root, "home") }, log: (l) => (stdout.push(l), all.push(l)), info: (l) => void all.push(l), run }).then((code) => ({
    code,
    out: all.join("\n"),
    stdout: stdout.join("\n"),
  }));
}

const dims = (file: string) => {
  const img = jpeg.decode(readFileSync(file));
  return [img.width, img.height];
};
const has = (file: string, text: string) => readFileSync(file).includes(Buffer.from(text));

describe("vivah deliver", () => {
  it("finishes exported JPEGs into a new folder: location removed, credit written, originals untouched, bad files reported, ZIP packed", async () => {
    const exports = fresh("exports");
    writeFileSync(path.join(exports, "a.jpg"), located(400, 300));
    writeFileSync(path.join(exports, "b.JPEG"), located(400, 300, 1));
    writeFileSync(path.join(exports, "broken.jpg"), "this is not a jpeg at all");
    writeFileSync(path.join(exports, "notes.txt"), "ignored");
    writeFileSync(path.join(exports, "raw.cr3"), "ignored");
    const out = path.join(fresh("client"), "wedding");

    const r = await cli(["deliver", "--folder", exports, "--out", out, "--copyright", "© 2026 Test Studio", "--creator", "Test Studio", "--zip"]);

    expect(r.code).toBe(2);
    expect(r.stdout).toContain("Delivered 2 of 3 file(s)");
    expect(r.stdout).toContain("2 file(s) finished: location data removed from 2");
    expect(r.stdout).toMatch(/failed broken\.jpg: .*Not a readable JPEG/);
    expect(r.out).toContain("Location data is removed from every file, along with metadata that cannot be checked for it");
    for (const name of ["a.jpg", "b.JPEG"]) {
      expect(has(path.join(out, name), SECRET)).toBe(false);
      expect(has(path.join(out, name), "© 2026 Test Studio")).toBe(true);
      expect(has(path.join(out, name), "Canon")).toBe(true);
      expect(dims(path.join(out, name))).toEqual([400, 300]);
      expect(has(path.join(exports, name), SECRET)).toBe(true);
    }
    expect(existsSync(path.join(out, "broken.jpg"))).toBe(false);
    expect(existsSync(path.join(out, "notes.txt"))).toBe(false);

    const zip = path.join(path.dirname(out), "wedding.zip");
    expect(r.stdout).toContain(`ZIP: ${zip}`);
    const bytes = readFileSync(zip);
    expect(bytes.includes(Buffer.from("a.jpg")) && bytes.includes(Buffer.from("b.JPEG"))).toBe(true);
    expect(bytes.includes(Buffer.from("broken.jpg"))).toBe(false);
    expect(bytes.includes(Buffer.from(SECRET))).toBe(false);
  });

  it("applies a preset's size ceiling and a watermark, and reports machine-readable results with --json", async () => {
    const exports = fresh("exports");
    writeFileSync(path.join(exports, "a.jpg"), located(400, 300));
    writeFileSync(path.join(exports, "small.jpg"), located(100, 80, 1));
    const logo = path.join(exports, "..", `logo-${counter}.png`);
    writeFileSync(logo, logoPng(16, 8, [255, 255, 255, 255]));
    const out = fresh("client");

    const r = await cli(["deliver", "--folder", exports, "--out", out, "--preset", "web", "--max-edge", "200", "--watermark", logo, "--watermark-position", "top-left", "--watermark-opacity", "100", "--watermark-size", "50", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ delivered: 2, failed: [], locationRemoved: 2, reencoded: 2, archives: [] });
    expect(dims(path.join(out, "a.jpg"))).toEqual([200, 150]);
    // 100 px wide, already within the ceiling, but the watermark still re-encodes it.
    expect(dims(path.join(out, "small.jpg"))).toEqual([100, 80]);
    expect(has(path.join(out, "a.jpg"), SECRET)).toBe(false);
    expect(r.out).toContain("Watermark");

    const px = (file: string, x: number, y: number) => {
      const img = jpeg.decode(readFileSync(file));
      return img.data[(y * img.width + x) * 4]!;
    };
    // 50% of 200 px is 100 px but the 16 px logo is never enlarged: white at the top-left margin, original photo elsewhere.
    expect(px(path.join(out, "a.jpg"), 4 + 4, 4 + 2)).toBeGreaterThan(235);
    expect(px(path.join(out, "a.jpg"), 150, 100)).toBeLessThan(235);
  });

  it("keeps location data only when asked to, and says so", async () => {
    const exports = fresh("exports");
    writeFileSync(path.join(exports, "a.jpg"), located(120, 90));
    const out = fresh("client");
    const r = await cli(["deliver", "--folder", exports, "--out", out, "--keep-gps", "--creator", "Me"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Location data is kept (--keep-gps).");
    expect(has(path.join(out, "a.jpg"), SECRET)).toBe(true);
    expect(has(path.join(out, "a.jpg"), "Me")).toBe(true);
  });

  it("warns when --keep-gps cannot apply because the photo is re-encoded", async () => {
    const exports = fresh("exports");
    writeFileSync(path.join(exports, "a.jpg"), located(400, 300));
    const out = fresh("client");
    const r = await cli(["deliver", "--folder", exports, "--out", out, "--keep-gps", "--max-edge", "200"]);
    expect(r.out).toContain("--keep-gps cannot apply to re-encoded photos");
    expect(has(path.join(out, "a.jpg"), SECRET)).toBe(false);
  });

  it("rejects bad input before touching any file", async () => {
    const exports = fresh("exports");
    writeFileSync(path.join(exports, "a.jpg"), located(100, 80));
    const out = path.join(fresh("client"), "never-created");
    const logo = path.join(exports, "..", "not-a-png.png");
    writeFileSync(logo, "not a png, just text long enough to be read as a header");

    const cases: [string[], RegExp][] = [
      [["--preset", "huge"], /Unknown preset "huge"/],
      [["--max-edge", "abc"], /--max-edge must be a number/],
      [["--quality", "101"], /Quality must be/],
      [["--format", "jpeg"], /--format applies to exports/],
      [["--watermark-position", "top-left"], /need --watermark/],
      [["--watermark", logo], /not-a-png\.png.*Not a PNG/],
      [["--watermark-size", "0", "--watermark", logo], /between 1 and 100/],
      [["--zip-max-mb", "5"], /needs --zip/],
      [["--zip", "--zip-max-mb", "0"], /at least 1/],
      [["--concurrency", "0"], /--concurrency must be/],
    ];
    for (const [extra, message] of cases) {
      const r = await cli(["deliver", "--folder", exports, "--out", out, ...extra]);
      expect(r.code, extra.join(" ")).toBe(1);
      expect(r.out, extra.join(" ")).toMatch(message);
    }
    expect(existsSync(out)).toBe(false);
  });

  it("refuses to write over the source folder or to run on a folder without JPEGs", async () => {
    const exports = fresh("exports");
    writeFileSync(path.join(exports, "a.jpg"), located(100, 80));
    const same = await cli(["deliver", "--folder", exports, "--out", exports]);
    expect(same.code).toBe(1);
    expect(same.out).toContain("must be a different folder");
    expect(has(path.join(exports, "a.jpg"), SECRET)).toBe(true);

    const empty = fresh("empty");
    writeFileSync(path.join(empty, "x.cr3"), "raw");
    const none = await cli(["deliver", "--folder", empty, "--out", path.join(root, "o")]);
    expect(none.code).toBe(1);
    expect(none.out).toContain("No JPEG files found");
    expect((await cli(["deliver", "--out", "x"])).out).toContain("--folder is required");
  });
});

describe("delivery during export (RawTherapee)", () => {
  const profile = path.join(root, "warm.profile.json");
  writeFileSync(profile, JSON.stringify({ id: "warm", name: "Warm", version: 1, summary: "warm and airy", baseAdjustments: { exposure: 0.3 } }));

  /** Stands in for rawtherapee-cli: reports a version, and writes a 600×400 JPEG with GPS wherever -o points. */
  function fakeRawTherapee(overrides: Record<string, () => Buffer> = {}): ProcessRunner {
    return async (_cmd, args) => {
      if (args[0] === "-v") return { code: 0, stdout: "RawTherapee, version 5.10", stderr: "" };
      const out = args[args.indexOf("-o") + 1]!;
      const name = path.basename(out);
      writeFileSync(out, overrides[name]?.() ?? located(600, 400, name === "b.jpg" ? 1 : 0));
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  async function job() {
    const shoot = fresh("shoot");
    writeFileSync(path.join(shoot, "a.jpg"), located(160, 120));
    writeFileSync(path.join(shoot, "b.jpg"), located(160, 120, 1));
    const db = path.join(shoot, "..", `jobs-${counter}.db`);
    const edited = await cli(["edit", "--folder", shoot, "--profile", profile, "--provider", "mock", "--adapter", "rawtherapee", "--db", db, "--job", "j"], fakeRawTherapee());
    expect(edited.code).toBe(0);
    return { shoot, db, args: ["--folder", shoot, "--adapter", "rawtherapee", "--db", db, "--job", "j"] };
  }

  it("enforces the size on a file the editor did not shrink (this fake ignores the resize it is asked for), removes location and writes the credit", async () => {
    const { args } = await job();
    const out = fresh("export");
    const r = await cli(["export", ...args, "--approve-all", "--export-dir", out, "--preset", "web", "--max-edge", "300", "--copyright", "© Test", "--creator", "Test Studio"], fakeRawTherapee());

    expect(r.code).toBe(0);
    expect(r.out).toContain("Delivery: web preset");
    expect(r.stdout).toContain("Exported 2 photo(s)");
    expect(r.stdout).toContain("2 file(s) finished: location data removed from 2, 2 re-encoded");
    for (const name of ["a.jpg", "b.jpg"]) {
      expect(dims(path.join(out, name))).toEqual([300, 200]);
      expect(has(path.join(out, name), SECRET)).toBe(false);
      expect(has(path.join(out, name), "© Test")).toBe(true);
    }
  });

  it("removes location from a full-resolution export without re-encoding it", async () => {
    const { args } = await job();
    const out = fresh("export");
    const r = await cli(["export", ...args, "--approve-all", "--export-dir", out, "--preset", "print"], fakeRawTherapee());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("2 file(s) finished: location data removed from 2");
    expect(r.stdout).not.toContain("re-encoded");
    expect(dims(path.join(out, "a.jpg"))).toEqual([600, 400]);
    expect(has(path.join(out, "a.jpg"), SECRET)).toBe(false);
    expect(has(path.join(out, "a.jpg"), "Canon")).toBe(true);
  });

  it("fails an item whose file cannot be finished and deletes the unfinished file instead of leaving it to be delivered", async () => {
    const { args } = await job();
    const out = fresh("export");
    const r = await cli(["export", ...args, "--approve-all", "--export-dir", out, "--preset", "print"], fakeRawTherapee({ "b.jpg": () => Buffer.from("corrupt output") }));
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/failed b\.jpg: \[EXPORT_FINISH_FAILED\] b\.jpg was exported but could not be finished/);
    expect(r.stdout).toContain("Exported 1 photo(s)");
    expect(existsSync(path.join(out, "b.jpg"))).toBe(false);
    expect(has(path.join(out, "a.jpg"), SECRET)).toBe(false);
  });

  it("explains delivery flags that cannot work: no export folder, or an editor that only writes edits", async () => {
    const { args } = await job();
    const stray = await cli(["export", ...args, "--approve-all", "--copyright", "© Test"], fakeRawTherapee());
    expect(stray.code).toBe(1);
    expect(stray.out).toMatch(/--copyright need --export-dir.*vivah deliver/);

    const shoot = fresh("shoot-xmp");
    writeFileSync(path.join(shoot, "a.jpg"), located(160, 120));
    const db = path.join(shoot, "..", `xmp-${counter}.db`);
    await cli(["edit", "--folder", shoot, "--profile", profile, "--provider", "mock", "--db", db, "--job", "j"]);
    const note = await cli(["export", "--folder", shoot, "--db", db, "--job", "j", "--approve-all", "--export-dir", fresh("never"), "--copyright", "© Test"]);
    expect(note.code).toBe(0);
    expect(note.out).toContain("writes edits only and does not export");
    expect(note.out).toContain("Approved 1 photo(s)");
  });

  it("will not export TIFF through the delivery step", async () => {
    const { args } = await job();
    const r = await cli(["export", ...args, "--approve-all", "--export-dir", fresh("export"), "--format", "tiff"], fakeRawTherapee());
    expect(r.code).toBe(1);
    expect(r.out).toContain("TIFF files cannot be finished");
  });

  it("delivers both a RAW and its camera JPEG under their own names instead of one overwriting the other", async () => {
    const shoot = fresh("shoot-pair");
    // The "RAW" is a JPEG with a RAW extension, which the preview extractor reads as an embedded preview.
    writeFileSync(path.join(shoot, "IMG_1.cr3"), located(160, 120));
    writeFileSync(path.join(shoot, "IMG_1.jpg"), located(160, 120, 1));
    const db = path.join(shoot, "..", `pair-${counter}.db`);
    const args = ["--folder", shoot, "--adapter", "rawtherapee", "--db", db, "--job", "j"];
    expect((await cli(["edit", ...args.slice(0, 2), "--profile", profile, "--provider", "mock", ...args.slice(2)], fakeRawTherapee())).code).toBe(0);

    const out = fresh("export");
    const r = await cli(["export", ...args, "--approve-all", "--export-dir", out, "--preset", "print"], fakeRawTherapee());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Exported 2 photo(s)");
    expect(readdirSync(out).sort()).toEqual(["IMG_1-jpg.jpg", "IMG_1.jpg"]);
    for (const name of readdirSync(out)) expect(has(path.join(out, name), SECRET)).toBe(false);
  });

  it("refuses an export folder that is the folder the photos came from, before anything is exported or deleted", async () => {
    const { shoot, args } = await job();
    const same = await cli(["export", ...args, "--approve-all", "--export-dir", shoot, "--preset", "print"], fakeRawTherapee());
    expect(same.code).toBe(1);
    expect(same.out).toContain("--export-dir must be a different folder from --folder");
    expect(has(path.join(shoot, "a.jpg"), SECRET)).toBe(true);
    expect(readFileSync(path.join(shoot, "a.jpg")).length).toBe(located(160, 120).length);

    // Spelled differently it is still the same folder, and so is the review command.
    const respelled = await cli(["export", ...args, "--approve-all", "--export-dir", path.join(shoot, "..", path.basename(shoot))], fakeRawTherapee());
    expect(respelled.out).toContain("must be a different folder");
    const review = await cli(["review", "--folder", shoot, "--profile", profile, "--adapter", "rawtherapee", "--export-dir", shoot], fakeRawTherapee());
    expect(review.code).toBe(1);
    expect(review.out).toContain("must be a different folder");
  });
});

describe("vivah deliver: content that cannot be checked", () => {
  it("reports what was dropped, in the summary and in --json", async () => {
    const vendor = (b: Buffer) => {
      const payload = Buffer.from("GoPro\0GPS5 xx");
      return Buffer.concat([b.subarray(0, 2), Buffer.from([0xff, 0xe6, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload, b.subarray(2)]);
    };
    const exports = fresh("exports");
    writeFileSync(path.join(exports, "a.jpg"), Buffer.concat([vendor(located(120, 90)), Buffer.from("MOTION-PHOTO-VIDEO-BYTES")]));
    writeFileSync(path.join(exports, "b.jpg"), located(120, 90, 1));
    const out = fresh("client");

    const r = await cli(["deliver", "--folder", exports, "--out", out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("2 file(s) finished: location data removed from 2; unchecked data dropped from 1 (APP6 block, trailing data)");
    expect(readFileSync(path.join(out, "a.jpg")).includes("MOTION-PHOTO")).toBe(false);
    expect(readFileSync(path.join(out, "a.jpg")).includes("GoPro")).toBe(false);

    const json = JSON.parse((await cli(["deliver", "--folder", exports, "--out", fresh("again"), "--json"])).stdout);
    expect(json.dropped).toEqual({ files: 1, kinds: ["APP6 block", "trailing data"] });
  });
});
