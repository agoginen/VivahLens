import { z } from "zod";
import type { LlmGateway } from "../llm/gateway.js";
import type { ContentPart } from "../llm/types.js";
import { EditRecipeSchema, type EditRecipe, type RecipeAdjustments } from "../recipe/editRecipe.js";
import { layerOnto, PHOTO_EDIT_REPLY, readCompactReply, STYLE_REPLY, withoutNeutralSliders } from "./replySchemas.js";
import type { StyleExemplar } from "./retrieval.js";
import { StyleProfileSchema, type StyleProfile } from "./styleProfile.js";

export interface Preview {
  mediaType: string;
  dataBase64: string;
}

const RECIPE_RULES = `Adjustment ranges: exposure -5..5 (EV); contrast/highlights/shadows/whites/blacks/vibrance/saturation -100..100; whiteBalance.tempK 2000..50000, tint -150..150.`;

/** The shape both replies use: give every one of these, with 0 for "no change" (and tempK 0 / tint 0 to leave white balance as shot). */
const REPLY_SETTINGS = `{"exposure": number, "contrast": number, "highlights": number, "shadows": number, "whites": number, "blacks": number, "vibrance": number, "saturation": number, "whiteBalance": {"tempK": number, "tint": number}}`;

const images = (previews: readonly Preview[]): ContentPart[] =>
  previews.map((p) => ({ type: "image", mediaType: p.mediaType, dataBase64: p.dataBase64 }));

const LearnedStyleSchema = z.preprocess(readCompactReply, StyleProfileSchema.pick({ summary: true, baseAdjustments: true }));

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
          content: `You analyze a photographer's finished photos and describe their editing style as numeric develop adjustments.\n${RECIPE_RULES}\nReply with JSON: {"summary": string, "baseAdjustments": ${REPLY_SETTINGS}}. Use 0 for any setting the photographer leaves alone.`,
        },
        {
          role: "user",
          content: [{ type: "text", text: "Reference photos in the photographer's style:" }, ...images(args.references)],
        },
      ],
      temperature: 0,
      purpose: "style-learning",
      jsonSchema: STYLE_REPLY,
    },
    LearnedStyleSchema,
  );
  // Settings the photographer leaves alone are not part of the style.
  const baseAdjustments = withoutNeutralSliders(learned.baseAdjustments) as RecipeAdjustments;
  return { id: args.id, name: args.name, version: 1, summary: learned.summary, baseAdjustments };
}

const ProposedRecipeSchema = z.preprocess(readCompactReply, EditRecipeSchema.pick({ adjustments: true, confidence: true, notes: true }));

export interface SceneContext {
  /** 1-based scene group of this photo and how many groups the album has. */
  index: number;
  total: number;
  meanLuma: number;
  tempK: number;
}

/**
 * One vision call per photo: propose a recipe that applies the profile to this specific frame. The model sets the
 * settings that vary from photo to photo; everything else in the style (curves, colour, grain) stays as the style has it.
 */
export async function proposeRecipe(
  gateway: LlmGateway,
  args: { preview: Preview; profile: StyleProfile; scene?: SceneContext; /** Finished photos of this look that resemble this one. */ examples?: readonly StyleExemplar[] },
): Promise<EditRecipe> {
  const sceneLine = args.scene
    ? `\nScene context: lighting group ${args.scene.index} of ${args.scene.total} (mean brightness ${Math.round(args.scene.meanLuma)}/255, estimated ${Math.round(args.scene.tempK)}K). Photos in the same group share lighting, so keep their exposure and white-balance corrections consistent.`
    : "";
  const examples = args.examples ?? [];
  const exampleLine = examples.length
    ? "\nYou are also shown finished photos from this photographer that resemble the photo to edit, with the adjustments used for each. Take guidance on the look from them, but correct for THIS frame's own exposure and white balance rather than copying their values."
    : "";
  const exampleParts: ContentPart[] = examples.flatMap((e, i): ContentPart[] => [
    { type: "text", text: `Finished example ${i + 1}, adjustments used: ${JSON.stringify(e.adjustments)}` },
    ...images([e.preview]),
  ]);
  const proposed = await gateway.completeJson(
    "vision",
    {
      messages: [
        {
          role: "system",
          content: `You adapt a photographer's style to one photo. Start from the style's base adjustments and correct for this frame's exposure and white balance.\n${RECIPE_RULES}\nStyle summary: ${args.profile.summary}\nBase adjustments: ${JSON.stringify(args.profile.baseAdjustments)}${sceneLine}${exampleLine}\nReply with JSON: {"adjustments": ${REPLY_SETTINGS}, "confidence": 0..1, "notes": string}. Settings you do not mention (curves, colour, grain, crop) stay as the style sets them.`,
        },
        { role: "user", content: [...exampleParts, { type: "text", text: "Photo to edit:" }, ...images([args.preview])] },
      ],
      temperature: 0,
      purpose: "recipe",
      jsonSchema: PHOTO_EDIT_REPLY,
    },
    ProposedRecipeSchema,
  );
  const base = args.profile.baseAdjustments;
  const adjustments = layerOnto(base, withoutNeutralSliders(proposed.adjustments, base));
  return {
    version: "1.0",
    assetType: "photo",
    sourceStyleProfileId: args.profile.id,
    adjustments,
    ...(proposed.confidence !== undefined && { confidence: proposed.confidence }),
    ...(proposed.notes !== undefined && { notes: proposed.notes }),
  };
}
