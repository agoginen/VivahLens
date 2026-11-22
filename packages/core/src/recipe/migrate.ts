import { EditRecipeSchema, type EditRecipe } from "./editRecipe.js";

/** The recipe version this build writes and applies. */
export const CURRENT_RECIPE_VERSION = "1.0";

/** Turns a recipe of version `from` into the next version. Kept in order; each step is small and tested on its own. */
export interface RecipeConverter {
  from: string;
  to: string;
  convert(recipe: Record<string, unknown>): Record<string, unknown>;
}

/**
 * Forward-only converter chain (plan §7b, schema migration policy): when a breaking change bumps `EditRecipe.version`,
 * a converter from the old version is added here so recipes saved earlier stay re-appliable. Empty while 1.0 is the
 * only version that has ever shipped.
 */
export const RECIPE_CONVERTERS: RecipeConverter[] = [];

/** Orders dotted version numbers numerically, so "1.10" is newer than "1.9". */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Brings a stored recipe up to the current version and validates it. Throws a message fit for the user when the
 * recipe is from a newer app, when there is no path of converters from its version, or when it is invalid.
 */
export function migrateRecipe(input: unknown, converters: readonly RecipeConverter[] = RECIPE_CONVERTERS, target: string = CURRENT_RECIPE_VERSION): EditRecipe {
  if (!input || typeof input !== "object") throw new Error("A recipe must be an object");
  let current = input as Record<string, unknown>;
  const seen = new Set<string>();
  while (current.version !== target) {
    const version = String(current.version);
    if (seen.has(version)) throw new Error(`Recipe converters loop at version ${version}`);
    seen.add(version);
    const step = converters.find((c) => c.from === version);
    if (!step) {
      throw new Error(
        compareVersions(version, target) > 0
          ? `This recipe is version ${version}, newer than this app understands (${target}); update the app`
          : `No converter from recipe version ${version} to ${target}`,
      );
    }
    current = { ...step.convert(structuredClone(current)), version: step.to };
  }
  return EditRecipeSchema.parse(current);
}
