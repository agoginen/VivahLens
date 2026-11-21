import type { LlmGateway } from "../llm/gateway.js";
import type { ContentPart } from "../llm/types.js";
import { EditRecipeSchema, type EditRecipe } from "../recipe/editRecipe.js";
import { StyleProfileSchema, type StyleProfile } from "./styleProfile.js";

export interface Preview {
  mediaType: string;
  dataBase64: string;
}

const RECIPE_RULES = `Adjustment ranges: exposure -5..5 (EV); contrast/highlights/shadows/whites/blacks/vibrance/saturation -100..100; whiteBalance.tempK 2000..50000, tint -150..150. Omit fields you would not change.`;

const images = (previews: readonly Preview[]): ContentPart[] =>
  previews.map((p) => ({ type: "image", mediaType: p.mediaType, dataBase64: p.dataBase64 }));

const LearnedStyleSchema = StyleProfileSchema.pick({ summary: true, baseAdjustments: true });

/** One vision call: derive a style profile from the photographer's finished reference photos. */
export async function learnStyle(
  gateway: LlmGateway,
  args: { id: string; name: string; references: readonly Preview[] },
): Promise<StyleProfile> {
  const learned = await gateway.completeJson(
    "vision",
    {
      messages: [
        {
          role: "system",
          content: `You analyze a photographer's finished photos and describe their editing style as numeric develop adjustments.\n${RECIPE_RULES}\nReply with JSON: {"summary": string, "baseAdjustments": {...}}.`,
        },
        {
          role: "user",
          content: [{ type: "text", text: "Reference photos in the photographer's style:" }, ...images(args.references)],
        },
      ],
      temperature: 0,
    },
    LearnedStyleSchema,
  );
  return { id: args.id, name: args.name, version: 1, ...learned };
}

const ProposedRecipeSchema = EditRecipeSchema.pick({ adjustments: true, confidence: true, notes: true });

/** One vision call per photo: propose a recipe that applies the profile to this specific frame. */
export async function proposeRecipe(
  gateway: LlmGateway,
  args: { preview: Preview; profile: StyleProfile },
): Promise<EditRecipe> {
  const proposed = await gateway.completeJson(
    "vision",
    {
      messages: [
        {
          role: "system",
          content: `You adapt a photographer's style to one photo. Start from the style's base adjustments and correct for this frame's exposure and white balance.\n${RECIPE_RULES}\nStyle summary: ${args.profile.summary}\nBase adjustments: ${JSON.stringify(args.profile.baseAdjustments)}\nReply with JSON: {"adjustments": {...}, "confidence": 0..1, "notes": string}.`,
        },
        { role: "user", content: [{ type: "text", text: "Photo to edit:" }, ...images([args.preview])] },
      ],
      temperature: 0,
    },
    ProposedRecipeSchema,
  );
  return { version: "1.0", assetType: "photo", sourceStyleProfileId: args.profile.id, ...proposed };
}
