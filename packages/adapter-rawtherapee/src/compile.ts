import type { EditRecipe } from "@vivahlens/core";

/**
 * Recipe fields translated to PP3. Key names under [Exposure] Compensation and
 * [Directional Pyramid Denoising] were checked against RawTherapee's shipped profiles; the rest follow
 * the standard PP3 layout but MUST be validated against a real RawTherapee install (Phase 0 spike).
 * White-balance tint and the highlights/shadows/whites/blacks sliders are not mapped: RawTherapee's
 * equivalents use different scales, so they are reported as unsupported rather than guessed.
 */
export const SUPPORTED_FIELDS = ["exposure", "contrast", "saturation", "vibrance", "whiteBalance", "noiseReduction", "sharpening"] as const;

type Section = Record<string, string | number | boolean>;

export function compileToPp3(recipe: EditRecipe): string {
  const a = recipe.adjustments;
  const sections: Record<string, Section> = {};
  const section = (name: string): Section => (sections[name] ??= {});

  if (a.exposure !== undefined) section("Exposure").Compensation = round(a.exposure, 2);
  if (a.contrast !== undefined) section("Exposure").Contrast = Math.round(a.contrast);
  if (a.saturation !== undefined) section("Exposure").Saturation = Math.round(a.saturation);

  if (a.vibrance !== undefined) {
    const v = section("Vibrance");
    v.Enabled = true;
    v.Pastels = Math.round(a.vibrance);
    v.Saturated = Math.round(a.vibrance);
  }

  if (a.whiteBalance?.tempK !== undefined) {
    const wb = section("White Balance");
    wb.Setting = "Custom";
    wb.Temperature = Math.round(a.whiteBalance.tempK);
  }

  if (a.noiseReduction) {
    const nr = section("Directional Pyramid Denoising");
    nr.Enabled = true;
    if (a.noiseReduction.luminance !== undefined) nr.Luma = Math.round(a.noiseReduction.luminance);
    if (a.noiseReduction.color !== undefined) nr.Chroma = Math.round(a.noiseReduction.color);
  }

  if (a.sharpening) {
    const s = section("Sharpening");
    s.Enabled = true;
    if (a.sharpening.amount !== undefined) s.Amount = Math.round(Math.min(a.sharpening.amount, 100));
    if (a.sharpening.radius !== undefined) s.Radius = round(a.sharpening.radius, 1);
  }

  return Object.entries(sections)
    .map(([name, kv]) => `[${name}]\n${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join("\n")}\n`)
    .join("\n");
}

const round = (n: number, digits: number) => Number(n.toFixed(digits));
