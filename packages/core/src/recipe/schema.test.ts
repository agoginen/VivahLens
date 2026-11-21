import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { describe, expect, it } from "vitest";
import { EditRecipeSchema } from "./editRecipe.js";

const committed = fileURLToPath(new URL("../../schema/edit-recipe.schema.json", import.meta.url));

describe("EditRecipe JSON Schema artifact", () => {
  it("is up to date with the zod schema (run `npm run build && npm run schema` after changing it)", () => {
    const generated = zodToJsonSchema(EditRecipeSchema, { name: "EditRecipe", $refStrategy: "none" });
    expect(JSON.parse(readFileSync(committed, "utf8"))).toEqual(generated);
  });

  it("describes the contract plugin authors rely on", () => {
    const schema = JSON.parse(readFileSync(committed, "utf8")) as {
      definitions: { EditRecipe: { required: string[]; properties: { version: { const: string }; adjustments: { properties: Record<string, { minimum?: number; maximum?: number }> } } } };
    };
    const recipe = schema.definitions.EditRecipe;
    expect(recipe.required).toEqual(["version", "assetType", "adjustments"]);
    expect(recipe.properties.version.const).toBe("1.0");
    expect(recipe.properties.adjustments.properties.exposure).toMatchObject({ minimum: -5, maximum: 5 });
  });
});
