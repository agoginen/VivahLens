import { HSL_COLORS, type EditRecipe, type RecipeAdjustments } from "../recipe/editRecipe.js";
import { SCALAR_PATHS, readScalar, type StyleProfile } from "./styleProfile.js";

const HSL_CHANNELS = ["hue", "saturation", "luminance"] as const;
const SPLIT_KEYS = ["highlightHue", "highlightSaturation", "shadowHue", "shadowSaturation", "balance"] as const;

/** Every numeric setting a style can carry, as a flat "dotted.path" → value map. */
function flatten(adj: RecipeAdjustments): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of SCALAR_PATHS) {
    const v = readScalar(adj, p);
    if (v !== undefined) out.set(p, v);
  }
  for (const color of HSL_COLORS) {
    for (const ch of HSL_CHANNELS) {
      const v = adj.hsl?.[color]?.[ch];
      if (v !== undefined) out.set(`hsl.${color}.${ch}`, v);
    }
  }
  for (const k of SPLIT_KEYS) {
    const v = adj.splitToning?.[k];
    if (v !== undefined) out.set(`splitToning.${k}`, v);
  }
  for (const k of ["luminance", "color"] as const) {
    const v = adj.noiseReduction?.[k];
    if (v !== undefined) out.set(`noiseReduction.${k}`, v);
  }
  for (const k of ["amount", "radius"] as const) {
    const v = adj.sharpening?.[k];
    if (v !== undefined) out.set(`sharpening.${k}`, v);
  }
  return out;
}

function setPath(target: Record<string, unknown>, dotted: string, value: number): void {
  const parts = dotted.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
  node[parts.at(-1)!] = value;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export interface ProfileFromRecipesOptions {
  id: string;
  name: string;
  /** A setting must appear in at least this share of the edits to count as part of the style. */
  minShare?: number;
}

/**
 * Builds a style profile from a photographer's finished edits: the median of each setting they actually use.
 * Exact numbers, no LLM. Settings whose median is zero (untouched sliders) are left out.
 */
export function profileFromRecipes(recipes: readonly EditRecipe[], opts: ProfileFromRecipesOptions): StyleProfile {
  if (recipes.length === 0) throw new Error("Cannot learn a style from zero edits");
  const minCount = Math.max(1, Math.ceil((opts.minShare ?? 0.4) * recipes.length));
  const values = new Map<string, number[]>();
  for (const r of recipes) {
    for (const [path, v] of flatten(r.adjustments)) values.set(path, [...(values.get(path) ?? []), v]);
  }

  const base: Record<string, unknown> = {};
  const described: string[] = [];
  for (const [path, list] of [...values].sort(([a], [b]) => a.localeCompare(b))) {
    if (list.length < minCount) continue;
    const m = median(list);
    if (m === 0) continue;
    setPath(base, path, m);
    if (described.length < 8 && !path.includes(".")) described.push(`${path} ${m > 0 ? "+" : ""}${Number(m.toFixed(2))}`);
  }

  return {
    id: opts.id,
    name: opts.name,
    version: 1,
    summary: `Learned from ${recipes.length} finished edit(s) (median of settings used in ≥${Math.round((opts.minShare ?? 0.4) * 100)}% of them)${described.length ? `: ${described.join(", ")}` : ""}.`,
    baseAdjustments: base as RecipeAdjustments,
  };
}
