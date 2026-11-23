// @ts-check
// Small DOM helpers shared by the page's scripts. Text only ever goes in as text, never as markup.

/**
 * Builds an element. `class` sets the class name, `on...` adds a listener, `true` makes an empty attribute, and an attribute
 * given `undefined`, `null` or `false` is left off. Children may be nested arrays; strings become text.
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false || value === null) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** The element with this id. The page's skeleton has them all, so there is always one. */
export const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
