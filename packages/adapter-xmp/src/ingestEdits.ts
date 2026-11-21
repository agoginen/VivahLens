import { promises as fs } from "node:fs";
import path from "node:path";
import type { EditRecipe } from "@vivahlens/core";
import { isGeneratedByVivah } from "./compile.js";
import { parseCrsToRecipe } from "./parse.js";

export interface IngestedEdit {
  file: string;
  recipe: EditRecipe;
  /** Written by VivahLens itself rather than by the photographer's editor. */
  generated: boolean;
}

/** Reads every `.xmp` sidecar in a folder and returns the finished edits it can understand. Unreadable or setting-free files are skipped. */
export async function readXmpEdits(dir: string): Promise<{ edits: IngestedEdit[]; skipped: string[] }> {
  const names = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith(".xmp")).sort();
  const edits: IngestedEdit[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const xmp = await fs.readFile(file, "utf8");
      const recipe = parseCrsToRecipe(xmp);
      if (recipe && Object.keys(recipe.adjustments).length > 0) edits.push({ file, recipe, generated: isGeneratedByVivah(xmp) });
      else skipped.push(name);
    } catch {
      skipped.push(name);
    }
  }
  return { edits, skipped };
}
