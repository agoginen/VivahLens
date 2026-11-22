import { unsupportedFields, type EditRecipe } from "@vivahlens/core";
import { downscale } from "@vivahlens/ingest";
import { applyHsl, applySaturation, applySplitToning, applyVibrance } from "./colorOps.js";
import { clamp01, linearToSrgb, srgb8ToLinear, type Rgba } from "./color.js";
import { applyDehaze, applyGrain, applyLocalContrast, applyNoiseReduction, applySharpening, applyVignette } from "./detail.js";
import { cropGeometry, sampleCrop } from "./geometry.js";
import { applyCurveLut, applyGains, applyLumaLut, buildCurveLut, buildToneLut, DEFAULT_AS_SHOT_K, whiteBalanceGains } from "./tone.js";

/** The recipe fields this renderer turns into pixels. A `.cube` look-up table and video edits are not among them. */
export const RENDER_FIELDS = [
  "exposure", "contrast", "whiteBalance", "highlights", "shadows", "whites", "blacks", "vibrance", "saturation",
  "clarity", "texture", "dehaze", "toneCurve", "hsl", "splitToning", "crop", "vignette", "grain", "noiseReduction", "sharpening",
] as const;

export interface RenderOptions {
  /** The temperature the picture was balanced to when it was made; a recipe's temperature is a change from this. */
  asShotTempK?: number;
  /** How much smaller this picture is than the one the recipe is meant for, so sharpening keeps its proportions. */
  detailScale?: number;
  /** Longest side of the result; the cropped picture is shrunk to fit and never enlarged. */
  maxEdge?: number;
  /** Seeds film grain, so the same inputs always give the same pixels. */
  seed?: number;
}

/** Recipe fields that will not show in a render, so a UI can say so rather than show an edit that is not there. */
export const unrenderedFields = (recipe: EditRecipe) => unsupportedFields(recipe, RENDER_FIELDS);

/**
 * Draws a recipe onto a picture: a plain-TypeScript approximation of what Lightroom or RawTherapee would do with the
 * same settings, meant for previews and for a no-editor workflow rather than for matching another program's pixels.
 * Crop and straighten come first, then colour temperature and exposure and haze on linear light, then tone, colour
 * and detail on encoded values, then vignette and grain. The source is never modified; a new picture is returned.
 */
export function renderRecipe(source: Rgba, recipe: EditRecipe, opts: RenderOptions = {}): Rgba {
  const a = recipe.adjustments;
  const geometry = cropGeometry(source.width, source.height, a.crop);
  let image: Rgba = geometry ? sampleCrop(source, geometry) : source;
  const fullWidth = Math.max(1, Math.round(geometry?.width ?? source.width));
  if (opts.maxEdge && Math.max(image.width, image.height) > opts.maxEdge) image = downscale(image, opts.maxEdge);
  const { width: w, height: h } = image;
  const detailScale = (opts.detailScale ?? 1) * (w / fullWidth);

  const px = new Float32Array(w * h * 3);
  for (let i = 0, p = 0; p < w * h; i += 3, p++) {
    px[i] = srgb8ToLinear(image.data[p * 4]!);
    px[i + 1] = srgb8ToLinear(image.data[p * 4 + 1]!);
    px[i + 2] = srgb8ToLinear(image.data[p * 4 + 2]!);
  }

  const wb = a.whiteBalance;
  const stops = a.exposure ?? 0;
  if (wb?.tempK !== undefined || wb?.tint || stops) {
    const [r, g, b] = whiteBalanceGains(wb?.tempK, wb?.tint, opts.asShotTempK ?? DEFAULT_AS_SHOT_K);
    const gain = 2 ** stops;
    applyGains(px, r * gain, g * gain, b * gain);
  }
  if (a.dehaze) applyDehaze(px, w, h, a.dehaze);
  for (let i = 0; i < px.length; i++) px[i] = linearToSrgb(px[i]!);

  const tone = buildToneLut({ highlights: a.highlights, shadows: a.shadows, whites: a.whites, blacks: a.blacks, contrast: a.contrast });
  if (tone) applyLumaLut(px, tone);
  const curve = a.toneCurve?.length ? buildCurveLut(a.toneCurve) : undefined;
  if (curve) applyCurveLut(px, curve);
  if (a.hsl) applyHsl(px, a.hsl);
  if (a.vibrance) applyVibrance(px, a.vibrance);
  if (a.saturation) applySaturation(px, Math.max(0, 1 + a.saturation / 100));
  if (a.splitToning) applySplitToning(px, a.splitToning);
  if (a.noiseReduction) applyNoiseReduction(px, w, h, a.noiseReduction.luminance ?? 0, a.noiseReduction.color ?? 0);
  if (a.clarity || a.texture) applyLocalContrast(px, w, h, a.clarity ?? 0, a.texture ?? 0);
  if (a.sharpening?.amount) applySharpening(px, w, h, a.sharpening.amount, a.sharpening.radius ?? 1, detailScale);
  if (a.vignette) applyVignette(px, w, h, a.vignette);
  if (a.grain) applyGrain(px, w, h, a.grain, opts.seed ?? ((w * 73856093) ^ (h * 19349663)));

  const out = new Uint8Array(w * h * 4);
  for (let i = 0, p = 0; p < w * h; i += 3, p++) {
    out[p * 4] = Math.round(clamp01(px[i]!) * 255);
    out[p * 4 + 1] = Math.round(clamp01(px[i + 1]!) * 255);
    out[p * 4 + 2] = Math.round(clamp01(px[i + 2]!) * 255);
    out[p * 4 + 3] = 255;
  }
  return { width: w, height: h, data: out };
}
