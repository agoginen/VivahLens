import type { EditRecipe } from "../recipe/editRecipe.js";
import { readScalar, SCALAR_PATHS, type ScalarPath } from "./styleProfile.js";

export interface Outlier {
  id: string;
  path: ScalarPath;
  value: number;
  mean: number;
}

/**
 * Flags recipes whose scalar values deviate strongly from the album, for human review.
 * It never rewrites them: photographers want to know why one image looks different.
 */
export function findOutliers(items: readonly { id: string; recipe: EditRecipe }[], zThreshold = 2.5): Outlier[] {
  const out: Outlier[] = [];
  for (const path of SCALAR_PATHS) {
    const values = items
      .map((i) => ({ id: i.id, v: readScalar(i.recipe.adjustments, path) }))
      .filter((x): x is { id: string; v: number } => x.v !== undefined);
    if (values.length < 5) continue;
    const mean = values.reduce((s, x) => s + x.v, 0) / values.length;
    const std = Math.sqrt(values.reduce((s, x) => s + (x.v - mean) ** 2, 0) / values.length);
    if (std === 0) continue;
    for (const { id, v } of values) {
      if (Math.abs(v - mean) / std > zThreshold) out.push({ id, path, value: v, mean });
    }
  }
  return out;
}
