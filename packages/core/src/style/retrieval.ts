import type { AssetRef } from "../adapters/editorAdapter.js";
import type { EditRecipe } from "../recipe/editRecipe.js";
import type { Preview } from "./styleEngine.js";

/** A finished photo from the learned style, with the adjustments the photographer used for it. */
export interface StyleExemplar {
  id: string;
  preview: Preview;
  adjustments: EditRecipe["adjustments"];
}

/**
 * Finds the reference photos that look most like a photo (plan §2b, embedding + nearest neighbour), so the model is
 * shown the photographer's own handling of similar light and subject instead of one global style.
 */
export interface StyleRetriever {
  /** Ids of the reference photos nearest to this one, best first. */
  nearest(asset: AssetRef, count: number): Promise<string[]>;
  /** The reference photos with these ids. Unknown ids are skipped. */
  exemplars(ids: readonly string[]): Promise<StyleExemplar[]>;
}
