import type { EditRecipe } from "@vivahlens/core";

/**
 * Recipe fields translated to PP3. Key names and ranges follow RawTherapee 5.13's source and GUI limits
 * (docs/research/photo-editor-formats-verification-2.md); none of it has been run through RawTherapee here.
 * Not mapped, so reported as unsupported: white-balance tint (RawTherapee's Green is a multiplier, not a ±150 tint), whites and
 * blacks (different scales), clarity, texture, grain, HSL and split toning.
 */
export const SUPPORTED_FIELDS = [
  "exposure",
  "contrast",
  "saturation",
  "vibrance",
  "whiteBalance",
  "highlights",
  "shadows",
  "toneCurve",
  "dehaze",
  "vignette",
  "crop",
  "noiseReduction",
  "sharpening",
] as const;

type Section = Record<string, string | number | boolean>;

const round = (n: number, digits: number) => Number(n.toFixed(digits));
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** A curve in PP3's list syntax: the type (1 = spline), then x;y pairs on 0 to 1, ascending in x. */
function pp3Curve(curve: readonly { input: number; output: number }[]): string | undefined {
  const byInput = new Map<number, number>();
  for (const p of curve) byInput.set(round(clamp(p.input, 0, 255) / 255, 6), round(clamp(p.output, 0, 255) / 255, 6));
  const points = [...byInput].sort(([a], [b]) => a - b);
  if (points[0]?.[0] !== 0) points.unshift([0, 0]);
  if (points.at(-1)![0] !== 1) points.push([1, 1]);
  if (points.length < 3 || points.every(([x, y]) => x === y)) return undefined; // fewer than two real points, or a straight line
  return `1;${points.map(([x, y]) => `${x};${y}`).join(";")};`;
}

export interface Pp3Output {
  pp3: string;
  /** What in the recipe could not be written, and why. */
  warnings: string[];
}

export function compileToPp3Detailed(recipe: EditRecipe): Pp3Output {
  const a = recipe.adjustments;
  const sections: Record<string, Section> = {};
  const section = (name: string): Section => (sections[name] ??= {});
  const warnings: string[] = [];

  if (a.exposure !== undefined) section("Exposure").Compensation = round(a.exposure, 2);
  if (a.contrast !== undefined) section("Exposure").Contrast = Math.round(a.contrast);
  if (a.saturation !== undefined) section("Exposure").Saturation = Math.round(a.saturation);
  if (a.toneCurve) {
    const curve = pp3Curve(a.toneCurve);
    if (curve) {
      section("Exposure").CurveMode = "Standard";
      section("Exposure").Curve = curve;
    } else if (a.toneCurve.length > 0) {
      warnings.push("The tone curve has fewer than two distinct points or changes nothing, so it was not written.");
    }
  }

  if (a.vibrance !== undefined) {
    const v = section("Vibrance");
    v.Enabled = true;
    v.Pastels = Math.round(a.vibrance);
    v.Saturated = Math.round(a.vibrance);
  }

  if (a.whiteBalance?.tempK !== undefined) {
    const wb = section("White Balance");
    wb.Enabled = true;
    wb.Setting = "Custom";
    wb.Temperature = Math.round(clamp(a.whiteBalance.tempK, 1500, 60000));
  }

  // RawTherapee's Shadows & Highlights is one-sided (0 to 100): it recovers highlights and lifts shadows.
  const recover = a.highlights !== undefined ? Math.round(clamp(-a.highlights, 0, 100)) : 0;
  const lift = a.shadows !== undefined ? Math.round(clamp(a.shadows, 0, 100)) : 0;
  if (recover > 0 || lift > 0) {
    const sh = section("Shadows & Highlights");
    sh.Enabled = true;
    sh.Highlights = recover;
    sh.HighlightTonalWidth = 70;
    sh.Shadows = lift;
    sh.ShadowTonalWidth = 30;
    sh.Radius = 40;
  }
  if ((a.highlights ?? 0) > 0 || (a.shadows ?? 0) < 0) {
    warnings.push("RawTherapee's Shadows & Highlights only recovers highlights and lifts shadows, so brightening highlights or darkening shadows was not applied.");
  }

  if (a.dehaze !== undefined) {
    if (a.dehaze > 0) {
      const d = section("Dehaze");
      d.Enabled = true;
      d.Strength = Math.round(clamp(a.dehaze, 0, 100));
    } else if (a.dehaze < 0) {
      warnings.push("RawTherapee's Dehaze cannot add haze, so a negative dehaze was not applied.");
    }
  }

  if (a.vignette && (a.vignette.amount !== undefined || a.vignette.feather !== undefined || a.vignette.roundness !== undefined)) {
    const pc = section("PCVignette");
    pc.Enabled = true;
    if (a.vignette.amount !== undefined) pc.Strength = round(clamp(a.vignette.amount, -100, 100) * 0.06, 2);
    if (a.vignette.feather !== undefined) pc.Feather = Math.round(clamp(a.vignette.feather, 0, 100));
    if (a.vignette.roundness !== undefined) pc.Roundness = Math.round((clamp(a.vignette.roundness, -100, 100) + 100) / 2);
  }

  if (a.crop) {
    if (a.crop.rotationDeg !== undefined && a.crop.rotationDeg !== 0) {
      section("Rotation").Degree = round(clamp(a.crop.rotationDeg, -45, 45), 2);
      warnings.push("The direction of the straightening angle has not been verified in RawTherapee; check straightened photos.");
    }
    if (a.crop.x !== undefined || a.crop.y !== undefined || a.crop.width !== undefined || a.crop.height !== undefined || a.crop.aspectRatio !== undefined) {
      warnings.push("RawTherapee crops in pixels, which depends on the photo's size, so the crop was not applied.");
    }
  }

  if (a.noiseReduction) {
    const nr = section("Directional Pyramid Denoising");
    nr.Enabled = true;
    if (a.noiseReduction.luminance !== undefined) nr.Luma = Math.round(a.noiseReduction.luminance);
    if (a.noiseReduction.color !== undefined) nr.Chroma = Math.round(a.noiseReduction.color);
  }

  if (a.sharpening) {
    const s = section("Sharpening");
    if (a.sharpening.amount === 0) {
      s.Enabled = false;
    } else {
      s.Enabled = true;
      // The recipe's amount is on Lightroom's 0 to 150 scale (40 is a typical raw default); RawTherapee's unsharp mask
      // runs 1 to 1000 with 200 as its default, so 40 maps to 200. A heuristic, not a verified equivalence.
      if (a.sharpening.amount !== undefined) s.Amount = Math.round(clamp(a.sharpening.amount * 5, 1, 1000));
      if (a.sharpening.radius !== undefined) s.Radius = round(clamp(a.sharpening.radius, 0.3, 3), 1);
    }
  }

  const pp3 = Object.entries(sections)
    .map(([name, kv]) => `[${name}]\n${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join("\n")}\n`)
    .join("\n");
  return { pp3, warnings };
}

export function compileToPp3(recipe: EditRecipe): string {
  return compileToPp3Detailed(recipe).pp3;
}

/**
 * A second profile, layered over the recipe with another `-p`, that scales the export so its long edge is `longEdgePx`.
 * It never enlarges, and applies to the cropped result.
 */
export function resizeProfile(longEdgePx: number): string {
  return `[Resize]\nEnabled=true\nAppliesTo=Cropped area\nMethod=Lanczos\nDataSpecified=4\nLongEdge=${Math.round(longEdgePx)}\nAllowUpscaling=false\n`;
}
