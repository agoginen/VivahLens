import { z } from "zod";
import { RecipeAdjustmentsSchema, type RecipeAdjustments } from "../recipe/editRecipe.js";

export const StyleProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.number().int().min(1),
  /** Short natural-language description of the look, kept for the review UI and future prompts. */
  summary: z.string(),
  /** The photographer's typical adjustments; per-photo recipes start from here. */
  baseAdjustments: RecipeAdjustmentsSchema,
});
export type StyleProfile = z.infer<typeof StyleProfileSchema>;

/** A scalar adjustment addressed by path, e.g. "exposure" or "whiteBalance.tempK". */
export type ScalarPath =
  | "exposure"
  | "contrast"
  | "highlights"
  | "shadows"
  | "whites"
  | "blacks"
  | "vibrance"
  | "saturation"
  | "clarity"
  | "texture"
  | "dehaze"
  | "whiteBalance.tempK"
  | "whiteBalance.tint";

export const SCALAR_PATHS: readonly ScalarPath[] = [
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "vibrance",
  "saturation",
  "clarity",
  "texture",
  "dehaze",
  "whiteBalance.tempK",
  "whiteBalance.tint",
];

export function readScalar(adj: RecipeAdjustments, path: ScalarPath): number | undefined {
  if (path === "whiteBalance.tempK") return adj.whiteBalance?.tempK;
  if (path === "whiteBalance.tint") return adj.whiteBalance?.tint;
  return adj[path];
}

function withScalar(adj: RecipeAdjustments, path: ScalarPath, value: number): RecipeAdjustments {
  if (path === "whiteBalance.tempK") return { ...adj, whiteBalance: { ...adj.whiteBalance, tempK: value } };
  if (path === "whiteBalance.tint") return { ...adj, whiteBalance: { ...adj.whiteBalance, tint: value } };
  return { ...adj, [path]: value };
}

export interface Override {
  path: ScalarPath;
  /** Value the photographer chose in the review UI. */
  value: number;
}

/** The scalar changes a reviewer made between the proposed and the final recipe. */
export function diffOverrides(original: RecipeAdjustments, final: RecipeAdjustments): Override[] {
  const out: Override[] = [];
  for (const path of SCALAR_PATHS) {
    const was = readScalar(original, path);
    const now = readScalar(final, path);
    if (now !== undefined && now !== was) out.push({ path, value: now });
  }
  return out;
}

/**
 * Nudges the profile toward the photographer's corrections (weighted average, not fine-tuning).
 * Returns a new profile with a bumped version; the input is not modified.
 */
export function learnFromOverrides(profile: StyleProfile, overrides: readonly Override[], rate = 0.2): StyleProfile {
  if (overrides.length === 0) return profile;
  let base = profile.baseAdjustments;
  for (const o of overrides) {
    const current = readScalar(base, o.path);
    base = withScalar(base, o.path, current === undefined ? o.value : current + rate * (o.value - current));
  }
  return { ...profile, baseAdjustments: base, version: profile.version + 1 };
}
