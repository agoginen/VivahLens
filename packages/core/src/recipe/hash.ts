import { createHash } from "node:crypto";

/** JSON with object keys in sorted order, so equal values always serialize to the same text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

/** Short stable identity of a recipe (or any JSON value): the first 16 hex digits of the SHA-256 of its canonical form. */
export function recipeHash(recipe: unknown): string {
  return createHash("sha256").update(canonicalJson(recipe)).digest("hex").slice(0, 16);
}
