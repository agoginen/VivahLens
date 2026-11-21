// Writes the language-neutral JSON Schema for EditRecipe (plan §7.3), so non-TypeScript consumers
// (the Lightroom Lua plugin, the Premiere UXP panel, docs) validate against the same contract.
// Run after `npm run build`:  npm run schema
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EditRecipeSchema } from "../packages/core/dist/index.js";
import { zodToJsonSchema } from "zod-to-json-schema";

export function editRecipeJsonSchema() {
  return zodToJsonSchema(EditRecipeSchema, { name: "EditRecipe", $refStrategy: "none" });
}

const out = fileURLToPath(new URL("../packages/core/schema/edit-recipe.schema.json", import.meta.url));
mkdirSync(new URL("../packages/core/schema/", import.meta.url), { recursive: true });
writeFileSync(out, `${JSON.stringify(editRecipeJsonSchema(), null, 2)}\n`, "utf8");
console.log(`wrote ${out}`);
