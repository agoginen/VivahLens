// @ts-check
// Which photos each tab of the review page shows.

/** @typedef {{ state: string, retouch?: boolean }} Item */

/** @type {{ id: string, matches: (item: Item) => boolean }[]} */
export const FILTERS = [
  { id: "review", matches: (i) => i.state === "review" },
  { id: "approved", matches: (i) => i.state === "approved" || i.state === "exported" || i.state === "delivered" },
  { id: "rejected", matches: (i) => i.state === "rejected" },
  { id: "failed", matches: (i) => i.state === "failed" },
  { id: "retouch", matches: (i) => i.retouch === true },
  { id: "all", matches: () => true },
];

/**
 * @template {Item} T
 * @param {readonly T[]} items
 * @param {string} filterId
 * @returns {T[]}
 */
export function filterItems(items, filterId) {
  const filter = FILTERS.find((f) => f.id === filterId) ?? FILTERS[FILTERS.length - 1];
  return items.filter((i) => filter.matches(i));
}

/**
 * How many photos each tab holds.
 * @param {readonly Item[]} items
 * @returns {Record<string, number>}
 */
export function countByFilter(items) {
  return Object.fromEntries(FILTERS.map((f) => [f.id, items.filter((i) => f.matches(i)).length]));
}

/**
 * The tab to open on: the one with photos waiting for review, else the first that has any, else all.
 * @param {readonly Item[]} items
 */
export function defaultFilter(items) {
  const counts = countByFilter(items);
  if (counts.review) return "review";
  return FILTERS.find((f) => f.id !== "all" && counts[f.id])?.id ?? "all";
}
