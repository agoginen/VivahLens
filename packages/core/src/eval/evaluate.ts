import { EditRecipeSchema, type EditRecipe } from "../recipe/editRecipe.js";
import { readScalar, SCALAR_PATHS, type ScalarPath } from "../style/styleProfile.js";

/** Largest difference still counted as "the same edit" per setting. Defaults are deliberately photographer-forgiving. */
export type Tolerances = Record<ScalarPath, number>;

export const DEFAULT_TOLERANCES: Tolerances = {
  exposure: 0.3,
  contrast: 12,
  highlights: 15,
  shadows: 15,
  whites: 15,
  blacks: 15,
  vibrance: 15,
  saturation: 15,
  "whiteBalance.tempK": 400,
  "whiteBalance.tint": 10,
};

export interface Deviation {
  path: ScalarPath;
  expected?: number;
  actual?: number;
  delta: number;
  withinTolerance: boolean;
}

export interface RecipeComparison {
  accepted: boolean;
  deviations: Deviation[];
}

/**
 * Compares a proposed recipe with the photographer's real one. A setting missing on one side counts as 0 (the slider
 * default); white balance missing on the proposal while the photographer set it is a miss. Extra strong changes the
 * photographer did not make are deviations too.
 */
export function compareRecipes(expected: EditRecipe, actual: EditRecipe, tolerances: Tolerances = DEFAULT_TOLERANCES): RecipeComparison {
  const deviations: Deviation[] = [];
  for (const path of SCALAR_PATHS) {
    const e = readScalar(expected.adjustments, path);
    const a = readScalar(actual.adjustments, path);
    if (e === undefined && a === undefined) continue;
    const isWb = path.startsWith("whiteBalance");
    if (isWb && e !== undefined && a === undefined) {
      deviations.push({ path, expected: e, delta: Infinity, withinTolerance: false });
      continue;
    }
    if (isWb && e === undefined) continue;
    const delta = Math.abs((a ?? 0) - (e ?? 0));
    deviations.push({ path, expected: e, actual: a, delta, withinTolerance: delta <= tolerances[path] });
  }
  return { accepted: deviations.every((d) => d.withinTolerance), deviations };
}

export interface EvalCase {
  id: string;
  expected: EditRecipe;
  /** What the model produced; anything that is not a valid EditRecipe counts as a schema failure. */
  actual: unknown;
}

export interface EvalReport {
  total: number;
  schemaValid: number;
  schemaValidRate: number;
  accepted: number;
  /** Accepted / total; schema failures count as not accepted. Phase 0 target ≥ 0.7. */
  acceptanceRate: number;
  perField: Record<string, { compared: number; withinTolerance: number; meanAbsDelta: number }>;
  cases: { id: string; schemaValid: boolean; accepted: boolean; deviations: Deviation[] }[];
}

/** Scores a set of proposals against ground truth; the core quality metric to track across models and prompts (plan §7.5). */
export function evaluateRecipes(cases: readonly EvalCase[], tolerances: Tolerances = DEFAULT_TOLERANCES): EvalReport {
  const perFieldAcc = new Map<string, { n: number; ok: number; sum: number }>();
  const results = cases.map((c) => {
    const parsed = EditRecipeSchema.safeParse(c.actual);
    if (!parsed.success) return { id: c.id, schemaValid: false, accepted: false, deviations: [] as Deviation[] };
    const cmp = compareRecipes(c.expected, parsed.data, tolerances);
    for (const d of cmp.deviations) {
      if (!Number.isFinite(d.delta)) continue;
      const acc = perFieldAcc.get(d.path) ?? { n: 0, ok: 0, sum: 0 };
      acc.n++;
      acc.sum += d.delta;
      if (d.withinTolerance) acc.ok++;
      perFieldAcc.set(d.path, acc);
    }
    return { id: c.id, schemaValid: true, accepted: cmp.accepted, deviations: cmp.deviations };
  });

  const schemaValid = results.filter((r) => r.schemaValid).length;
  const accepted = results.filter((r) => r.accepted).length;
  return {
    total: cases.length,
    schemaValid,
    schemaValidRate: cases.length ? schemaValid / cases.length : 0,
    accepted,
    acceptanceRate: cases.length ? accepted / cases.length : 0,
    perField: Object.fromEntries([...perFieldAcc].map(([k, v]) => [k, { compared: v.n, withinTolerance: v.ok, meanAbsDelta: v.sum / v.n }])),
    cases: results,
  };
}
