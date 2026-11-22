import { promises as fs } from "node:fs";
import path from "node:path";
import { EXPORT_PRESETS, resolveExportSpec, type ExportPresetName, type ExportSpec, type StageDeps } from "@vivahlens/core";
import { finishFile, loadWatermark, type FinishOptions, type WatermarkPosition } from "@vivahlens/delivery";

/** Flags that shape what a delivered file looks like. */
export const DELIVERY_FLAGS = ["preset", "format", "quality", "max-edge", "watermark", "watermark-position", "watermark-opacity", "watermark-size", "copyright", "creator", "keep-gps"] as const;

export type DeliveryFlags = Partial<Record<Exclude<(typeof DELIVERY_FLAGS)[number], "keep-gps">, string>> & { "keep-gps"?: boolean };

const POSITIONS: readonly WatermarkPosition[] = ["bottom-right", "bottom-left", "top-right", "top-left", "center"];
/** Limits of the IPTC-IIM fields; XMP keeps the full text. */
const IPTC_CREATOR_BYTES = 32;
const IPTC_COPYRIGHT_BYTES = 128;

export interface DeliveryTally {
  files: number;
  reencoded: number;
  locationRemoved: number;
  /** Files that had content dropped without being inspected, and the kinds of content dropped across them. */
  droppedFiles: number;
  droppedKinds: Set<string>;
}

export interface Delivery {
  /** What the editor is asked to export (also supplies the size ceiling and quality for `vivah deliver`). */
  spec: ExportSpec;
  /** Credit, watermark and location handling; the size ceiling comes from `spec`. */
  finish: FinishOptions;
  /** Lines to show before work starts: what will happen to every file, and any caveats. */
  notices: string[];
  tally: DeliveryTally;
  /** Undefined when the files need no post-processing. */
  afterExport?: NonNullable<StageDeps["afterExport"]>;
}

function parseNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n)) throw new Error(`--${flag} must be a number, got "${value}"`);
  return n;
}

function parsePercent(value: string | undefined, flag: string): number | undefined {
  const n = parseNumber(value, flag);
  if (n === undefined) return undefined;
  if (n < 1 || n > 100) throw new Error(`--${flag} must be between 1 and 100 (percent), got ${value}`);
  return n / 100;
}

/** Finishes one file and counts it. */
export async function finishTracked(source: string, destination: string, options: FinishOptions, tally: DeliveryTally): Promise<void> {
  const result = await finishFile(source, destination, options);
  tally.files++;
  if (result.reencoded) tally.reencoded++;
  if (result.locationRemoved) tally.locationRemoved++;
  if (result.dropped.length) {
    tally.droppedFiles++;
    for (const kind of result.dropped) tally.droppedKinds.add(kind);
  }
}

export function describeTally(tally: DeliveryTally): string {
  const dropped = tally.droppedFiles ? `; unchecked data dropped from ${tally.droppedFiles} (${[...tally.droppedKinds].sort().join(", ")})` : "";
  return `${tally.files} file(s) finished: location data removed from ${tally.locationRemoved}${tally.reencoded ? `, ${tally.reencoded} re-encoded` : ""}${dropped}`;
}

/**
 * Validates every delivery flag up front (a typo must fail before the first photo is touched) and decides what
 * happens to each file. Location data is removed unless `--keep-gps` is given.
 */
export async function planDelivery(v: DeliveryFlags, outputDir: string): Promise<Delivery> {
  const spec = resolveExportSpec({ preset: v.preset, format: v.format, maxEdgePx: parseNumber(v["max-edge"], "max-edge"), quality: parseNumber(v.quality, "quality"), outputDir });

  if (!v.watermark && (v["watermark-position"] || v["watermark-opacity"] || v["watermark-size"])) {
    throw new Error("--watermark-position, --watermark-opacity and --watermark-size need --watermark <logo.png>");
  }
  const position = v["watermark-position"] as WatermarkPosition | undefined;
  if (position !== undefined && !POSITIONS.includes(position)) throw new Error(`--watermark-position must be one of: ${POSITIONS.join(", ")}`);
  const watermark = v.watermark
    ? await loadWatermark(v.watermark, { position, opacity: parsePercent(v["watermark-opacity"], "watermark-opacity"), widthRatio: parsePercent(v["watermark-size"], "watermark-size") })
    : undefined;

  const copyright = v.copyright?.trim() || undefined;
  const creator = v.creator?.trim() || undefined;
  const finish: FinishOptions = { copyright, creator, watermark, scrubGps: !v["keep-gps"] };
  const needsFinishing = finish.scrubGps || copyright !== undefined || creator !== undefined || watermark !== undefined;
  if (spec.format === "tiff" && needsFinishing) {
    throw new Error("TIFF files cannot be finished yet (location removal, credit, watermark). Use --format jpeg, or pass --keep-gps to take the TIFF exactly as the editor wrote it.");
  }

  const tally: DeliveryTally = { files: 0, reencoded: 0, locationRemoved: 0, droppedFiles: 0, droppedKinds: new Set() };
  const active = spec.format === "jpeg" && (needsFinishing || spec.maxEdgePx !== undefined);
  const afterExport: Delivery["afterExport"] = active
    ? async (file, _asset, requested) => {
        try {
          await finishTracked(file, file, { ...finish, maxEdgePx: requested.maxEdgePx, quality: requested.quality }, tally);
        } catch (err) {
          // An unfinished file may still hold location data; it must not be delivered by accident.
          await fs.rm(file, { force: true });
          throw err;
        }
      }
    : undefined;

  const notices: string[] = [];
  const size = spec.maxEdgePx ? `long edge up to ${spec.maxEdgePx} px` : "full resolution";
  const label = v.preset ? `${v.preset} preset (${EXPORT_PRESETS[v.preset as ExportPresetName].description})` : `${spec.format.toUpperCase()}, ${size}${spec.quality ? `, quality ${spec.quality}` : ""}`;
  notices.push(`Delivery: ${label}.`);
  if (spec.format === "jpeg") {
    notices.push(finish.scrubGps ? "Location data is removed from every file, along with metadata that cannot be checked for it: vendor blocks, comments, the Exif thumbnail and anything after the image." : "Location data is kept (--keep-gps).");
    if (creator || copyright) notices.push(`Credit written to IPTC and XMP:${creator ? ` creator "${creator}"` : ""}${copyright ? ` copyright "${copyright}"` : ""}.`);
    if (watermark) notices.push(`Watermark ${path.basename(v.watermark!)} (${position ?? "bottom-right"}) re-encodes every photo: camera metadata is dropped, the colour profile is kept, and it takes about 4 s per 24 MP photo.`);
    else if (spec.maxEdgePx) notices.push(`Files still larger than ${spec.maxEdgePx} px are re-encoded smaller (camera metadata dropped, colour profile kept; about 3 s per 24 MP photo).`);
    if (v["keep-gps"] && (watermark || spec.maxEdgePx)) notices.push("Note: --keep-gps cannot apply to re-encoded photos; re-encoding drops location data.");
    if (creator && Buffer.byteLength(creator) > IPTC_CREATOR_BYTES) notices.push(`Note: the IPTC creator field holds ${IPTC_CREATOR_BYTES} bytes, so it is shortened there; XMP keeps the full name.`);
    if (copyright && Buffer.byteLength(copyright) > IPTC_COPYRIGHT_BYTES) notices.push(`Note: the IPTC copyright field holds ${IPTC_COPYRIGHT_BYTES} bytes, so it is shortened there; XMP keeps the full text.`);
  }
  return { spec, finish, notices, tally, afterExport };
}
