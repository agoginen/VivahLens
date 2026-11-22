import { promises as fs } from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import { VivahError, type AssetRef, type GrayImage, type Preview } from "@vivahlens/core";
import { extractEmbeddedJpeg } from "./embeddedJpeg.js";
import { readExif, type ExifInfo } from "./exif.js";
import { findExifSegment } from "./exifSegment.js";
import { applyOrientation, readOrientation, type Rgba } from "./orientation.js";

export const RAW_EXTENSIONS = [".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".dng", ".rw2"] as const;
export const IMAGE_EXTENSIONS = [...RAW_EXTENSIONS, ".jpg", ".jpeg"] as const;

/** Photo assets in a folder (non-recursive), sorted by name for a stable job order. */
export async function scanFolder(dir: string): Promise<AssetRef[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && (IMAGE_EXTENSIONS as readonly string[]).includes(path.extname(e.name).toLowerCase()))
    .map((e) => ({ id: e.name, kind: "photo" as const, path: path.join(dir, e.name) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function decodeEmbedded(embedded: Uint8Array, name: string): Rgba {
  try {
    // Orientation is read from the preview's own EXIF; RAW containers that keep it only in the outer
    // TIFF header still arrive unrotated (that value is exposed through `readExif` instead).
    const img = jpeg.decode(embedded, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    return applyOrientation({ width: img.width, height: img.height, data: img.data }, readOrientation(embedded));
  } catch (err) {
    throw new VivahError("ASSET_UNREADABLE", `Cannot decode preview of ${name}: ${(err as Error).message}`);
  }
}

async function readAsset(file: string): Promise<{ bytes: Uint8Array; embedded: Uint8Array }> {
  const bytes = await fs.readFile(file);
  const embedded = extractEmbeddedJpeg(bytes);
  if (!embedded) throw new VivahError("ASSET_UNREADABLE", `No embedded JPEG preview found in ${path.basename(file)}`);
  return { bytes, embedded };
}

async function decodePreview(file: string): Promise<Rgba> {
  const { embedded } = await readAsset(file);
  return decodeEmbedded(embedded, path.basename(file));
}

/** Box-filter downscale so the long edge is at most `maxEdge`; never upscales. */
export function downscale(img: Rgba, maxEdge: number): Rgba {
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  if (scale === 1) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          r += img.data[i]!;
          g += img.data[i + 1]!;
          b += img.data[i + 2]!;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * The picture to edit and show: a JPEG itself, or a RAW file's embedded preview (the part a camera makes, not a develop of
 * the raw data), turned upright, shrunk to `maxEdge` when given.
 */
export async function loadRgba(asset: AssetRef, opts: { maxEdge?: number } = {}): Promise<Rgba> {
  const full = await decodePreview(asset.path);
  return opts.maxEdge ? downscale(full, opts.maxEdge) : full;
}

/** The EXIF block (camera, lens, capture time) of an asset's picture, for carrying into a finished JPEG; undefined when there is none. */
export async function loadExifSegment(asset: AssetRef): Promise<Uint8Array | undefined> {
  const { embedded } = await readAsset(asset.path);
  return findExifSegment(embedded);
}

/** JPEG preview (default 2048px long edge) for the LLM. Originals never leave the machine. */
export async function loadPreview(asset: AssetRef, opts: { maxEdge?: number; quality?: number } = {}): Promise<Preview> {
  const small = downscale(await decodePreview(asset.path), opts.maxEdge ?? 2048);
  const encoded = jpeg.encode({ data: small.data, width: small.width, height: small.height }, opts.quality ?? 85);
  return { mediaType: "image/jpeg", dataBase64: Buffer.from(encoded.data).toString("base64") };
}

/** Small grayscale decode (default 512px) used for culling; thresholds are calibrated at this size. */
export async function loadGray(asset: AssetRef, opts: { maxEdge?: number } = {}): Promise<GrayImage> {
  const small = downscale(await decodePreview(asset.path), opts.maxEdge ?? 512);
  const gray = new Uint8Array(small.width * small.height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(0.299 * small.data[i * 4]! + 0.587 * small.data[i * 4 + 1]! + 0.114 * small.data[i * 4 + 2]!);
  }
  return { width: small.width, height: small.height, data: gray };
}

export interface SceneStats {
  /** Mean luminance, 0–255. */
  meanLuma: number;
  /** Rough colour temperature from the red/blue balance; good enough to group scenes, not to set white balance. */
  tempK: number;
}

export interface Analysis {
  gray: GrayImage;
  scene: SceneStats;
  exif: ExifInfo;
}

/** One decode that yields everything the pipeline needs before any LLM call: culling image, scene signature, EXIF. */
export async function loadAnalysis(asset: AssetRef, opts: { maxEdge?: number } = {}): Promise<Analysis> {
  const { bytes, embedded } = await readAsset(asset.path);
  const small = downscale(decodeEmbedded(embedded, path.basename(asset.path)), opts.maxEdge ?? 512);
  const gray = new Uint8Array(small.width * small.height);
  let r = 0;
  let b = 0;
  for (let i = 0; i < gray.length; i++) {
    const [pr, pg, pb] = [small.data[i * 4]!, small.data[i * 4 + 1]!, small.data[i * 4 + 2]!];
    gray[i] = Math.round(0.299 * pr + 0.587 * pg + 0.114 * pb);
    r += pr;
    b += pb;
  }
  const meanLuma = gray.reduce((s, v) => s + v, 0) / Math.max(1, gray.length);
  const ratio = Math.max(r, 1) / Math.max(b, 1);
  const tempK = Math.min(12000, Math.max(2000, 6500 * Math.pow(1 / ratio, 1.4)));
  return {
    gray: { width: small.width, height: small.height, data: gray },
    scene: { meanLuma, tempK },
    exif: readExif(bytes, embedded),
  };
}
