import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import { downscale, applyOrientation, readOrientation, type Rgba } from "@vivahlens/ingest";
import { injectCredit, type Credit } from "./credit.js";
import { scrubGps } from "./gps.js";
import { buildJpeg, isIccSegment, jpegSize, metadataInsertIndex, parseJpeg } from "./jpegSegments.js";
import { decodePng } from "./png.js";

export type WatermarkPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left" | "center";

export interface Watermark {
  /** PNG file contents (transparency is honoured). */
  png: Uint8Array;
  position?: WatermarkPosition;
  /** 0–1, default 0.6. */
  opacity?: number;
  /** Logo width as a share of the photo's width, default 0.18. */
  widthRatio?: number;
}

export interface FinishOptions extends Credit {
  /** Long-edge ceiling. Files already within it are not touched; larger ones are re-encoded smaller. */
  maxEdgePx?: number;
  /** JPEG quality for a re-encode (default 85). */
  quality?: number;
  watermark?: Watermark;
  /** Remove location data (default true). */
  scrubGps?: boolean;
}

export interface FinishResult {
  data: Uint8Array;
  /** The pixels were re-encoded (resize or watermark): camera/Exif data and other metadata are gone, the ICC profile is kept. */
  reencoded: boolean;
  /** The source carried location data and the result does not. A re-encode drops it even when `scrubGps` is off. */
  locationRemoved: boolean;
  /** Content dropped without being inspected because it could hide location (see `ScrubResult.dropped`). Empty after a re-encode, which drops everything but the colour profile anyway. */
  dropped: string[];
}

/** The logo is the same for every photo in a batch, so it is decoded once. */
const decodedLogos = new WeakMap<Uint8Array, Rgba>();
function decodeLogo(png: Uint8Array): Rgba {
  const cached = decodedLogos.get(png);
  if (cached) return cached;
  const logo = decodePng(png);
  decodedLogos.set(png, logo);
  return logo;
}

/** Box-filter scale to an exact width, averaging colour weighted by alpha so transparent areas stay transparent. */
function scaleLogo(img: Rgba, width: number): Rgba {
  const w = Math.max(1, width);
  const h = Math.max(1, Math.round((img.height * w) / img.width));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          const alpha = img.data[i + 3]!;
          r += img.data[i]! * alpha;
          g += img.data[i + 1]! * alpha;
          b += img.data[i + 2]! * alpha;
          a += alpha;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, data: out };
}

/** Places the logo on the photo with the given opacity; the logo is scaled by width and never enlarged. */
export function applyWatermark(photo: Rgba, mark: Rgba, opts: Omit<Watermark, "png"> = {}): Rgba {
  const { position = "bottom-right", opacity = 0.6, widthRatio = 0.18 } = opts;
  const targetW = Math.max(1, Math.min(mark.width, Math.round(photo.width * widthRatio)));
  const logo = targetW < mark.width ? scaleLogo(mark, targetW) : mark;
  const margin = Math.round(photo.width * 0.02);
  const left = position.endsWith("left") ? margin : position.endsWith("right") ? photo.width - logo.width - margin : Math.round((photo.width - logo.width) / 2);
  const top = position.startsWith("top") ? margin : position.startsWith("bottom") ? photo.height - logo.height - margin : Math.round((photo.height - logo.height) / 2);

  const out = new Uint8Array(photo.data);
  for (let y = 0; y < logo.height; y++) {
    const py = top + y;
    if (py < 0 || py >= photo.height) continue;
    for (let x = 0; x < logo.width; x++) {
      const px = left + x;
      if (px < 0 || px >= photo.width) continue;
      const s = (y * logo.width + x) * 4;
      const d = (py * photo.width + px) * 4;
      const a = (logo.data[s + 3]! / 255) * opacity;
      for (let c = 0; c < 3; c++) out[d + c] = Math.round(logo.data[s + c]! * a + out[d + c]! * (1 - a));
    }
  }
  return { width: photo.width, height: photo.height, data: out };
}

/**
 * Prepares an exported JPEG for delivery. A watermark, or a file larger than `maxEdgePx`, re-encodes the pixels: the
 * colour profile is carried over but Exif and all other metadata (so also location) are dropped. Otherwise nothing is
 * re-encoded: GPS is removed in place and the credit is written, keeping the camera data and colour profile.
 */
export function finishJpeg(input: Uint8Array, opts: FinishOptions = {}): FinishResult {
  const parsed = parseJpeg(input);
  if (!parsed) throw new Error("Not a readable JPEG file");
  const size = jpegSize(parsed);
  const tooLarge = opts.maxEdgePx !== undefined && (!size || Math.max(size.width, size.height) > opts.maxEdgePx);
  const reencoded = tooLarge || opts.watermark !== undefined;

  let data: Uint8Array;
  let locationRemoved: boolean;
  let dropped: string[] = [];
  if (reencoded) {
    const raw = jpeg.decode(input, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 200, maxMemoryUsageInMB: 2048 });
    let img: Rgba = applyOrientation({ width: raw.width, height: raw.height, data: raw.data }, readOrientation(input));
    if (tooLarge) img = downscale(img, opts.maxEdgePx!);
    if (opts.watermark) img = applyWatermark(img, decodeLogo(opts.watermark.png), opts.watermark);
    const encoded = parseJpeg(jpeg.encode({ data: img.data, width: img.width, height: img.height }, opts.quality ?? 85).data)!;
    const headers = [...encoded.headers];
    headers.splice(metadataInsertIndex(headers), 0, ...parsed.headers.filter(isIccSegment));
    data = buildJpeg(headers, encoded.scan);
    locationRemoved = scrubGps(input).removed;
  } else {
    const scrubbed = opts.scrubGps === false ? { data: input, removed: false, dropped } : scrubGps(input);
    data = scrubbed.data;
    locationRemoved = scrubbed.removed;
    dropped = scrubbed.dropped;
  }
  return { data: injectCredit(data, opts), reencoded, locationRemoved, dropped };
}

export interface FinishFileResult extends Omit<FinishResult, "data"> {
  file: string;
}

/**
 * `finishJpeg` for a file on disk: reads `source`, writes the result to `destination` (the same path for in-place),
 * atomically. Anything that is not a .jpg/.jpeg is refused, and a failed write leaves no partial file behind.
 */
export async function finishFile(source: string, destination: string, opts: FinishOptions = {}): Promise<FinishFileResult> {
  if (!/\.jpe?g$/i.test(source)) throw new Error(`${path.basename(source)} is not a JPEG; only JPEG deliveries can be finished`);
  const { data, ...result } = finishJpeg(await fs.readFile(source), opts);
  // A name of its own per call: two writers to one destination must never share (and then remove) a temp file.
  const tmp = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, destination);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  return { ...result, file: destination };
}

/** Reads a logo PNG and checks that it decodes now, so a bad file fails before any photo is processed. */
export async function loadWatermark(file: string, opts: Omit<Watermark, "png"> = {}): Promise<Watermark> {
  const png = new Uint8Array(await fs.readFile(file));
  try {
    decodeLogo(png);
  } catch (err) {
    throw new Error(`Watermark ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ...opts, png };
}
