import type { ExportSpec } from "../adapters/editorAdapter.js";

export const EXPORT_PRESET_NAMES = ["web", "social", "album", "print"] as const;
export type ExportPresetName = (typeof EXPORT_PRESET_NAMES)[number];

export interface ExportPreset {
  description: string;
  format: "jpeg";
  /** Long edge in pixels; omitted = full resolution. */
  maxEdgePx?: number;
  quality: number;
}

/**
 * Starting points, not promises about any platform: services change their limits, so every value can be overridden.
 * Colour space is whatever the editor's export produces; the delivery step keeps an embedded ICC profile.
 */
export const EXPORT_PRESETS: Readonly<Record<ExportPresetName, ExportPreset>> = {
  web: { description: "online gallery: long edge 2048 px, JPEG quality 85", format: "jpeg", maxEdgePx: 2048, quality: 85 },
  social: { description: "social media: long edge 1350 px (fits a 1080×1350 portrait), JPEG quality 85", format: "jpeg", maxEdgePx: 1350, quality: 85 },
  album: { description: "album design: long edge 3600 px (12 in at 300 dpi), JPEG quality 92", format: "jpeg", maxEdgePx: 3600, quality: 92 },
  print: { description: "print lab: full resolution, JPEG quality 95", format: "jpeg", quality: 95 },
};

export interface ExportChoices {
  preset?: string;
  format?: string;
  maxEdgePx?: number;
  quality?: number;
  outputDir: string;
}

/** A preset's values overridden by explicit choices, validated. Throws a message fit to show the user. */
export function resolveExportSpec(choices: ExportChoices): ExportSpec {
  const known = choices.preset !== undefined && (EXPORT_PRESET_NAMES as readonly string[]).includes(choices.preset);
  if (choices.preset !== undefined && !known) {
    throw new Error(`Unknown preset "${choices.preset}". Choose one of: ${EXPORT_PRESET_NAMES.join(", ")}.`);
  }
  const preset = known ? EXPORT_PRESETS[choices.preset as ExportPresetName] : undefined;
  const format = choices.format ?? preset?.format ?? "jpeg";
  if (format !== "jpeg" && format !== "tiff") throw new Error(`Unknown format "${format}". Use jpeg or tiff.`);

  const quality = choices.quality ?? preset?.quality;
  if (quality !== undefined && !(Number.isInteger(quality) && quality >= 1 && quality <= 100)) {
    throw new Error(`Quality must be a whole number from 1 to 100, got ${quality}.`);
  }
  const maxEdgePx = choices.maxEdgePx ?? preset?.maxEdgePx;
  if (maxEdgePx !== undefined && !(Number.isInteger(maxEdgePx) && maxEdgePx >= 100 && maxEdgePx <= 30_000)) {
    throw new Error(`Maximum edge must be a whole number of pixels from 100 to 30000, got ${maxEdgePx}.`);
  }
  return { format, outputDir: choices.outputDir, ...(maxEdgePx !== undefined && { maxEdgePx }), ...(quality !== undefined && { quality }) };
}
