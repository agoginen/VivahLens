import { EditRecipeSchema, type AssetRef, type EditRecipe, type PerceptualScore } from "@vivahlens/core";
import { loadRgba, type Rgba } from "@vivahlens/ingest";
import { compareImages, renderRecipe } from "@vivahlens/render";

export interface PerceptualCase {
  id: string;
  asset: AssetRef;
  /** The photographer's own edit. */
  expected: EditRecipe;
  /** What the model proposed; anything that is not a valid recipe has already been counted as a failure and is not scored here. */
  actual: unknown;
}

export interface PerceptualRun {
  scores: PerceptualScore[];
  /** Photos left out: the proposal was not a valid recipe, or the picture could not be read. */
  skipped: number;
}

/** The same recipe without its crop and straighten: framing is the photographer's composition, not the look being scored. */
function uncropped(recipe: EditRecipe): EditRecipe {
  const adjustments = { ...recipe.adjustments };
  delete adjustments.crop;
  return { ...recipe, adjustments };
}

/**
 * Scores proposed edits by what they do to the picture: the photographer's recipe and the model's are each drawn onto the
 * same photo and the two results compared (CIEDE2000 and SSIM). Sliders that differ can still give the same look, and
 * sliders that differ little can look different, which a comparison of the numbers cannot tell.
 */
export async function scorePerceptually(
  cases: readonly PerceptualCase[],
  opts: { load?: (asset: AssetRef) => Promise<Rgba>; signal?: AbortSignal } = {},
): Promise<PerceptualRun> {
  const load = opts.load ?? ((asset: AssetRef) => loadRgba(asset, { maxEdge: 512 }));
  const scores: PerceptualScore[] = [];
  let skipped = 0;
  for (const c of cases) {
    opts.signal?.throwIfAborted();
    const proposed = EditRecipeSchema.safeParse(c.actual);
    if (!proposed.success) {
      skipped++;
      continue;
    }
    let picture: Rgba;
    try {
      picture = await load(c.asset);
    } catch {
      skipped++;
      continue;
    }
    const draw = (recipe: EditRecipe) => renderRecipe(picture, uncropped(recipe));
    const result = compareImages(draw(c.expected), draw(proposed.data));
    scores.push({ id: c.id, deltaE: { mean: result.deltaE.mean, p95: result.deltaE.p95 }, ssim: result.ssim });
  }
  return { scores, skipped };
}
