// @ts-check
// Which photos are ticked on the review page, and how a click changes that. Every function returns a new set.

/**
 * Ticks the photo, or unticks it if it was ticked.
 * @param {ReadonlySet<string>} selected
 * @param {string} id
 */
export function toggle(selected, id) {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Ticks every photo from `anchor` to `target`, both included, in the order they are shown (a shift-click). Without an anchor
 * that is still on show, only `target` is ticked. A target that is not on show changes nothing.
 * @param {ReadonlySet<string>} selected
 * @param {readonly string[]} order
 * @param {string | undefined} anchor
 * @param {string} target
 */
export function selectRange(selected, order, anchor, target) {
  const next = new Set(selected);
  const to = order.indexOf(target);
  if (to < 0) return next;
  const from = anchor === undefined ? -1 : order.indexOf(anchor);
  const [first, last] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
  for (const id of order.slice(first, last + 1)) next.add(id);
  return next;
}

/**
 * "Select all": ticks every photo on show, or, when they are all ticked already, unticks them. Other photos keep their state.
 * @param {ReadonlySet<string>} selected
 * @param {readonly string[]} shown
 */
export function toggleAll(selected, shown) {
  const next = new Set(selected);
  const everyone = shown.length > 0 && shown.every((id) => next.has(id));
  for (const id of shown) {
    if (everyone) next.delete(id);
    else next.add(id);
  }
  return next;
}

/**
 * Drops the photos that are no longer in the list (they were set aside, or the job changed).
 * @param {ReadonlySet<string>} selected
 * @param {readonly string[]} known
 */
export function keepKnown(selected, known) {
  const present = new Set(known);
  return new Set([...selected].filter((id) => present.has(id)));
}

/**
 * How much of what is on show is ticked, for the "select all" box: none, some (a dash) or all (a tick).
 * @param {ReadonlySet<string>} selected
 * @param {readonly string[]} shown
 * @returns {"none" | "some" | "all"}
 */
export function coverage(selected, shown) {
  const ticked = shown.filter((id) => selected.has(id)).length;
  if (ticked === 0) return "none";
  return ticked === shown.length ? "all" : "some";
}
