import type { EditRecipe } from "@vivahlens/core";
import { cropParams, CROP, DEFAULT_EXPOSURE_EV, EXPOSURE, exposureParams } from "./params.js";
import type { HistoryEntry } from "./sidecar.js";

/**
 * The recipe fields this adapter turns into darktable history. Exposure and crop only: white balance would need the
 * camera's colour matrix (darktable stores raw-channel multipliers, not Kelvin and tint), and contrast, saturation and
 * the rest live in modules whose parameter layouts have not been verified (docs/research/darktable-integration-
 * verification.md §6). They are reported as unsupported instead of being guessed at.
 */
export const SUPPORTED_FIELDS = ["exposure", "crop"] as const;

/** A crop narrower than this on either side is a mistake, not a framing choice. */
const MIN_CROP_SPAN = 0.05;
/** The range darktable's exposure slider allows. */
const EXPOSURE_RANGE = 18;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export interface CompiledHistory {
  entries: HistoryEntry[];
  /** What in the recipe could not be written, and why. */
  warnings: string[];
}

export function compileToHistory(recipe: EditRecipe): CompiledHistory {
  const a = recipe.adjustments;
  const entries: HistoryEntry[] = [];
  const warnings: string[] = [];

  if (a.exposure !== undefined && a.exposure !== 0) {
    const ev = clamp(DEFAULT_EXPOSURE_EV + a.exposure, -EXPOSURE_RANGE, EXPOSURE_RANGE);
    entries.push({ operation: EXPOSURE.operation, modversion: EXPOSURE.modversion, params: exposureParams(ev) });
  }

  const crop = a.crop;
  if (crop) {
    const hasRectangle = crop.x !== undefined || crop.y !== undefined || crop.width !== undefined || crop.height !== undefined;
    if (hasRectangle) {
      // The recipe's rectangle is intersected with the picture, so one that hangs over an edge is cut there, not moved.
      const [x0, y0] = [crop.x ?? 0, crop.y ?? 0];
      const left = clamp(x0, 0, 1);
      const top = clamp(y0, 0, 1);
      const right = clamp(crop.width !== undefined ? x0 + crop.width : 1, left, 1);
      const bottom = clamp(crop.height !== undefined ? y0 + crop.height : 1, top, 1);
      if (right - left < MIN_CROP_SPAN || bottom - top < MIN_CROP_SPAN) warnings.push("The crop was too small to be real, so it was not applied");
      else if (left > 0 || top > 0 || right < 1 || bottom < 1) entries.push({ operation: CROP.operation, modversion: CROP.modversion, params: cropParams({ left, top, right, bottom }) });
    } else if (crop.aspectRatio) {
      warnings.push(`An aspect ratio (${crop.aspectRatio}) without a crop rectangle was not applied: darktable needs the rectangle`);
    }
    if (crop.rotationDeg) warnings.push(`Straightening by ${crop.rotationDeg}° was not applied: darktable's crop module cannot rotate`);
  }

  return { entries, warnings };
}
