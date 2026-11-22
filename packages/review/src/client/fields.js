// @ts-check
// The adjustments the review page lets a reviewer change, and how they map onto a recipe.

/**
 * @typedef {{ id: string, path: string[], min: number, max: number, step: number, fallback: number, decimals: number }} Field
 */

/** @type {Field[]} */
export const FIELDS = [
  { id: "exposure", path: ["exposure"], min: -5, max: 5, step: 0.05, fallback: 0, decimals: 2 },
  { id: "tempK", path: ["whiteBalance", "tempK"], min: 2000, max: 12000, step: 50, fallback: 5500, decimals: 0 },
  { id: "tint", path: ["whiteBalance", "tint"], min: -150, max: 150, step: 1, fallback: 0, decimals: 0 },
  { id: "contrast", path: ["contrast"], min: -100, max: 100, step: 1, fallback: 0, decimals: 0 },
  { id: "highlights", path: ["highlights"], min: -100, max: 100, step: 1, fallback: 0, decimals: 0 },
  { id: "shadows", path: ["shadows"], min: -100, max: 100, step: 1, fallback: 0, decimals: 0 },
  { id: "whites", path: ["whites"], min: -100, max: 100, step: 1, fallback: 0, decimals: 0 },
  { id: "blacks", path: ["blacks"], min: -100, max: 100, step: 1, fallback: 0, decimals: 0 },
  { id: "vibrance", path: ["vibrance"], min: -100, max: 100, step: 1, fallback: 0, decimals: 0 },
  { id: "saturation", path: ["saturation"], min: -100, max: 100, step: 1, fallback: 0, decimals: 0 },
  { id: "clarity", path: ["clarity"], min: -100, max: 100, step: 1, fallback: 0, decimals: 0 },
  { id: "texture", path: ["texture"], min: -100, max: 100, step: 1, fallback: 0, decimals: 0 },
  { id: "dehaze", path: ["dehaze"], min: -100, max: 100, step: 1, fallback: 0, decimals: 0 },
];

/**
 * The value a recipe has for a field, or undefined when it does not set one.
 * @param {Record<string, any>} adjustments
 * @param {Field} field
 * @returns {number | undefined}
 */
export function getValue(adjustments, field) {
  /** @type {any} */
  let at = adjustments;
  for (const key of field.path) at = at?.[key];
  return typeof at === "number" ? at : undefined;
}

/**
 * A copy of the adjustments with one field set; the original is not changed. The value is kept inside the field's range.
 * @param {Record<string, any>} adjustments
 * @param {Field} field
 * @param {number} value
 */
export function setValue(adjustments, field, value) {
  const next = structuredClone(adjustments);
  const bounded = Math.min(field.max, Math.max(field.min, value));
  /** @type {any} */
  let at = next;
  for (const key of field.path.slice(0, -1)) {
    at[key] = typeof at[key] === "object" && at[key] !== null ? at[key] : {};
    at = at[key];
  }
  at[field.path[field.path.length - 1]] = bounded;
  return next;
}

/**
 * How a value is shown on a slider.
 * @param {number} value
 * @param {Field} field
 * @param {string} locale
 */
export function formatValue(value, field, locale) {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: field.decimals, maximumFractionDigits: field.decimals, signDisplay: field.id === "tempK" ? "never" : "exceptZero" }).format(value);
}
