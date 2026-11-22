import type { JsonSchemaSpec } from "../llm/types.js";

/** The sliders a per-photo correction is expected to set; 0 means "no change from neutral". */
export const CORE_SLIDERS = ["exposure", "contrast", "highlights", "shadows", "whites", "blacks", "vibrance", "saturation"] as const;

const number = { type: "number" } as const;

/**
 * Adjustments in the shape every provider's strict structured-output mode accepts (docs/research/llm-api-verification-2.md
 * §1.5): every property required, no optionals, no bounds. The full recipe has dozens of optional settings, which is over
 * Anthropic's limit of 24 optional parameters, so the model is asked only for the settings that vary from photo to photo.
 * Everything else comes from the style the photographer already has. Ranges are enforced when the reply is parsed.
 */
const compactAdjustments = {
  type: "object",
  additionalProperties: false,
  required: [...CORE_SLIDERS, "whiteBalance"],
  properties: {
    ...Object.fromEntries(CORE_SLIDERS.map((k) => [k, number])),
    // 0 for either means "leave as shot".
    whiteBalance: { type: "object", additionalProperties: false, required: ["tempK", "tint"], properties: { tempK: number, tint: number } },
  },
};

/** One photo's correction: the model's reply to "apply this style to this frame". */
export const PHOTO_EDIT_REPLY: JsonSchemaSpec = {
  name: "photo_edit",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["adjustments", "confidence", "notes"],
    properties: { adjustments: compactAdjustments, confidence: number, notes: { type: "string" } },
  },
};

/** The style a model infers from finished photos. */
export const STYLE_REPLY: JsonSchemaSpec = {
  name: "style_profile",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "baseAdjustments"],
    properties: { summary: { type: "string" }, baseAdjustments: compactAdjustments },
  },
};

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Reads the "0 means unchanged" convention of the compact reply: a white-balance value of 0 is not a setting, and a
 * white-balance object with nothing left is not either. Anything that is not the compact shape is left for the schema to judge.
 */
export function readCompactAdjustments(adjustments: unknown): unknown {
  if (!isPlain(adjustments) || !isPlain(adjustments.whiteBalance)) return adjustments;
  const wb = Object.fromEntries(Object.entries(adjustments.whiteBalance).filter(([, v]) => v !== 0));
  const { whiteBalance: _original, ...rest } = adjustments;
  return Object.keys(wb).length ? { ...rest, whiteBalance: wb } : rest;
}

/** Applies `readCompactAdjustments` to the `adjustments` (or `baseAdjustments`) of a whole reply. */
export function readCompactReply(reply: unknown): unknown {
  if (!isPlain(reply)) return reply;
  const out: Plain = { ...reply };
  for (const key of ["adjustments", "baseAdjustments"]) if (key in out) out[key] = readCompactAdjustments(out[key]);
  return out;
}

/** Drops core sliders that sit at 0 in the reply when the style has no value for them, so a sidecar does not carry a wall of zeros. */
export function withoutNeutralSliders(adjustments: Plain, base: Plain = {}): Plain {
  const out: Plain = { ...adjustments };
  for (const key of CORE_SLIDERS) if (out[key] === 0 && base[key] === undefined) delete out[key];
  return out;
}

/** The style's own settings with the model's corrections laid over them: what the model sets wins, what it leaves out stays. */
export function layerOnto<T extends Plain>(base: T, corrections: Plain): T {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(corrections)) {
    out[key] = isPlain(value) && isPlain(out[key]) ? layerOnto(out[key] as Plain, value) : value;
  }
  return out as T;
}
