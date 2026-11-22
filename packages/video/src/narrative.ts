import { z } from "zod";
import type { LlmGateway, Preview } from "@vivahlens/core";
import type { Pick } from "./highlights.js";

export interface NarrativeShot {
  pick: Pick;
  /** A frame from the middle of the shot, sent to the vision model (previews only; footage never leaves the machine). */
  thumbnail: Preview;
}

export interface NarrativeResult {
  picks: Pick[];
  /** One short label per input shot, in input order ("ceremony", "first dance", ...). */
  labels: string[];
  usedLlm: boolean;
  warnings: string[];
}

const MAX_SHOTS = 40;

const ReplySchema = z.object({
  order: z.array(z.number().int()),
  labels: z.array(z.string().max(60)),
});

/**
 * Asks the vision model to put the chosen shots into a storytelling order (e.g. getting ready, ceremony, portraits,
 * reception, dance). The reply is only trusted if it is an exact permutation; otherwise the chronological order stands.
 * The model never edits anything: it returns indices that this code validates.
 */
export async function orderByNarrative(gateway: LlmGateway, shots: readonly NarrativeShot[]): Promise<NarrativeResult> {
  const chronological = shots.map((s) => s.pick);
  const fallback = (warning: string): NarrativeResult => ({ picks: chronological, labels: shots.map(() => ""), usedLlm: false, warnings: [warning] });

  if (shots.length < 3) return fallback("Too few shots to reorder; kept capture order.");
  if (shots.length > MAX_SHOTS) return fallback(`More than ${MAX_SHOTS} shots; kept capture order to limit cost.`);

  try {
    const reply = await gateway.completeJson(
      "vision",
      {
        messages: [
          {
            role: "system",
            content:
              `You are a wedding and event film editor. You will see ${shots.length} shots listed in the order they were filmed, each labelled "Shot <index>". ` +
              `Decide the best storytelling order for a highlight reel (for example getting ready, ceremony, portraits, reception, speeches, dancing). ` +
              `Reply with JSON only: {"order": [every index 0..${shots.length - 1} exactly once, in the new order], "labels": [one short label per shot, in the ORIGINAL index order]}.`,
          },
          {
            role: "user",
            content: shots.flatMap((s, i) => [
              { type: "text" as const, text: `Shot ${i}` },
              { type: "image" as const, mediaType: s.thumbnail.mediaType, dataBase64: s.thumbnail.dataBase64 },
            ]),
          },
        ],
        temperature: 0,
        purpose: "narrative",
      },
      ReplySchema,
    );

    const isPermutation = reply.order.length === shots.length && new Set(reply.order).size === shots.length && reply.order.every((i) => i >= 0 && i < shots.length);
    if (!isPermutation) return fallback("The model's order was not a valid permutation; kept capture order.");
    const labels = shots.map((_, i) => reply.labels[i] ?? "");
    return { picks: reply.order.map((i) => chronological[i]!), labels, usedLlm: true, warnings: [] };
  } catch (err) {
    return fallback(`Narrative ordering failed (${err instanceof Error ? err.message : "unknown error"}); kept capture order.`);
  }
}
