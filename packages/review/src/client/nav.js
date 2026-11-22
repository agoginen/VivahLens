// @ts-check
// Moving around the photo grid with the keyboard.

/**
 * How many cards fit in a row of the grid.
 * @param {number} containerWidth
 * @param {number} minCardWidth
 * @param {number} gap
 */
export function columnsFor(containerWidth, minCardWidth, gap) {
  return Math.max(1, Math.floor((containerWidth + gap) / (minCardWidth + gap)));
}

/**
 * Where the focus goes from `index` for a navigation key in a grid of `count` cards laid out `columns` to a row; the same
 * index when the key does not move it (the edge of the grid) or is not a navigation key.
 * @param {number} index
 * @param {string} key
 * @param {number} columns
 * @param {number} count
 * @param {{ ctrl?: boolean }} [modifiers]
 */
export function gridMove(index, key, columns, count, modifiers = {}) {
  if (count <= 0) return 0;
  const last = count - 1;
  const row = Math.floor(index / columns);
  switch (key) {
    case "ArrowRight":
      return Math.min(last, index + 1);
    case "ArrowLeft":
      return Math.max(0, index - 1);
    case "ArrowDown":
      // Below the last full row, a shorter last row still counts: go to its last card rather than not moving.
      return index + columns <= last ? index + columns : Math.floor(last / columns) > row ? last : index;
    case "ArrowUp":
      return Math.max(0, index - columns);
    case "Home":
      return modifiers.ctrl ? 0 : row * columns;
    case "End":
      return modifiers.ctrl ? last : Math.min(last, row * columns + columns - 1);
    case "PageDown":
      return Math.min(last, index + columns * 3);
    case "PageUp":
      return Math.max(0, index - columns * 3);
    default:
      return Math.min(Math.max(0, index), last);
  }
}

/**
 * The index to focus after the list changed (a photo left the filter): stay put, or step back from the end.
 * @param {number} index
 * @param {number} count
 */
export function settleFocus(index, count) {
  return count <= 0 ? -1 : Math.min(Math.max(0, index), count - 1);
}
