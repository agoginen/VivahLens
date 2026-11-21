import { z } from "zod";

const slider = z.number().min(-100).max(100);
const pct = z.number().min(0).max(100);
const triple = z.tuple([z.number(), z.number(), z.number()]);

export const HSL_COLORS = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"] as const;
export type HslColor = (typeof HSL_COLORS)[number];

const hslBand = z.object({ hue: slider, saturation: slider, luminance: slider }).partial();

const adjustments = z
  .object({
    exposure: z.number().min(-5).max(5),
    contrast: slider,
    whiteBalance: z
      .object({
        tempK: z.number().min(2000).max(50000),
        tint: z.number().min(-150).max(150),
      })
      .partial(),
    highlights: slider,
    shadows: slider,
    whites: slider,
    blacks: slider,
    vibrance: slider,
    saturation: slider,
    toneCurve: z.array(z.object({ input: z.number().min(0).max(255), output: z.number().min(0).max(255) })),
    hsl: z.record(z.enum(HSL_COLORS), hslBand),
    splitToning: z
      .object({
        highlightHue: z.number().min(0).max(360),
        highlightSaturation: pct,
        shadowHue: z.number().min(0).max(360),
        shadowSaturation: pct,
        balance: slider,
      })
      .partial(),
    crop: z
      .object({
        aspectRatio: z.string(),
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
        rotationDeg: z.number(),
      })
      .partial(),
    noiseReduction: z.object({ luminance: pct, color: pct }).partial(),
    sharpening: z
      .object({ amount: z.number().min(0).max(150), radius: z.number().min(0.5).max(3) })
      .partial(),
    lutRef: z.string(),
    videoEdits: z
      .object({
        cuts: z.array(
          z.object({
            clipId: z.string(),
            inSec: z.number().min(0),
            outSec: z.number().min(0),
            transitionIn: z.enum(["none", "cut", "crossfade", "dip-to-black"]).optional(),
          }),
        ),
        colorGrade: z.string(),
        cdl: z
          .object({ slope: triple, offset: triple, power: triple, saturation: z.number() })
          .partial(),
      })
      .partial(),
  })
  .partial();

export const RecipeAdjustmentsSchema = adjustments;

export const EditRecipeSchema = z.object({
  version: z.literal("1.0"),
  assetType: z.enum(["photo", "video"]),
  sourceStyleProfileId: z.string().optional(),
  adjustments: RecipeAdjustmentsSchema,
  confidence: z.number().min(0).max(1).optional(),
  notes: z.string().optional(),
});

export type EditRecipe = z.infer<typeof EditRecipeSchema>;
export type RecipeAdjustments = NonNullable<EditRecipe["adjustments"]>;
export type RecipeField = keyof RecipeAdjustments;

/** Adjustment fields a recipe actually sets. */
export function recipeFields(recipe: EditRecipe): RecipeField[] {
  return (Object.keys(recipe.adjustments) as RecipeField[]).filter((k) => recipe.adjustments[k] !== undefined);
}

/** Fields the adapter cannot honor, so the UI can warn before a job runs. */
export function unsupportedFields(recipe: EditRecipe, supported: readonly string[]): RecipeField[] {
  return recipeFields(recipe).filter((f) => !supported.includes(f));
}
