// @ts-check
// Message formatting for the review page: the small part of ICU MessageFormat that the page needs.
//   {name}                                   a value
//   {n, number}                              a number in the reader's own digits and grouping
//   {n, plural, one {# photo} other {# photos}}   a choice by plural category (# is the number); =0 and =1 match exactly
// Plural categories come from Intl.PluralRules, so Hindi (where 0 and 1 are both "one") and English each follow their own rules.

/** @typedef {{ type: "text", value: string } | { type: "arg", name: string } | { type: "number", name: string } | { type: "plural", name: string, cases: Map<string, Node[]> } | { type: "hash" }} Node */

/**
 * @param {string} source
 * @param {boolean} [inPlural]
 * @returns {Node[]}
 */
export function parseMessage(source, inPlural = false) {
  /** @type {Node[]} */
  const nodes = [];
  let text = "";
  const flush = () => {
    if (text) nodes.push({ type: "text", value: text });
    text = "";
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "#" && inPlural) {
      flush();
      nodes.push({ type: "hash" });
    } else if (c === "{") {
      let depth = 1;
      let j = i + 1;
      while (j < source.length && depth > 0) {
        if (source[j] === "{") depth++;
        else if (source[j] === "}") depth--;
        j++;
      }
      if (depth !== 0) throw new Error(`Unclosed { in message: ${source}`);
      flush();
      nodes.push(parseArgument(source.slice(i + 1, j - 1)));
      i = j - 1;
    } else if (c === "}") {
      throw new Error(`Unexpected } in message: ${source}`);
    } else text += c;
  }
  flush();
  return nodes;
}

/** @param {string} body @returns {Node} */
function parseArgument(body) {
  const first = body.indexOf(",");
  if (first < 0) return { type: "arg", name: body.trim() };
  const name = body.slice(0, first).trim();
  const rest = body.slice(first + 1);
  const second = rest.indexOf(",");
  const kind = (second < 0 ? rest : rest.slice(0, second)).trim();
  if (kind === "number") return { type: "number", name };
  if (kind !== "plural" || second < 0) throw new Error(`Unsupported argument type "${kind}" in {${body}}`);
  /** @type {Map<string, Node[]>} */
  const cases = new Map();
  const options = rest.slice(second + 1);
  let i = 0;
  while (i < options.length) {
    while (i < options.length && /\s/.test(options[i])) i++;
    if (i >= options.length) break;
    const start = i;
    while (i < options.length && !/[\s{]/.test(options[i])) i++;
    const selector = options.slice(start, i);
    while (i < options.length && /\s/.test(options[i])) i++;
    if (options[i] !== "{") throw new Error(`Expected { after "${selector}" in {${body}}`);
    let depth = 1;
    let j = i + 1;
    while (j < options.length && depth > 0) {
      if (options[j] === "{") depth++;
      else if (options[j] === "}") depth--;
      j++;
    }
    if (depth !== 0) throw new Error(`Unclosed { after "${selector}" in {${body}}`);
    cases.set(selector, parseMessage(options.slice(i + 1, j - 1), true));
    i = j;
  }
  if (!cases.has("other")) throw new Error(`A plural needs an "other" choice: {${body}}`);
  return { type: "plural", name, cases };
}

/**
 * @param {Node[]} nodes
 * @param {Record<string, unknown>} params
 * @param {string} locale
 * @param {number} [hash]
 * @returns {string}
 */
export function formatNodes(nodes, params, locale, hash) {
  const numbers = new Intl.NumberFormat(locale);
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") out += node.value;
    else if (node.type === "hash") out += hash === undefined ? "#" : numbers.format(hash);
    else if (node.type === "arg") out += node.name in params ? String(params[node.name]) : `{${node.name}}`;
    else if (node.type === "number") {
      const value = params[node.name];
      out += typeof value === "number" ? numbers.format(value) : `{${node.name}}`;
    } else {
      const n = params[node.name];
      if (typeof n !== "number") {
        out += `{${node.name}}`;
        continue;
      }
      const chosen = node.cases.get(`=${n}`) ?? node.cases.get(new Intl.PluralRules(locale).select(n)) ?? node.cases.get("other");
      out += formatNodes(chosen ?? [], params, locale, n);
    }
  }
  return out;
}

/**
 * @param {{ locale: string, fallback?: string, catalogs: Record<string, Record<string, string>> }} options
 */
export function createI18n(options) {
  const fallback = options.fallback ?? "en";
  /** @type {Map<string, Node[]>} */
  const parsed = new Map();
  /** @type {Set<string>} */
  const missing = new Set();
  let locale = options.locale in options.catalogs ? options.locale : fallback;

  /** @param {string} lang @param {string} key @returns {Node[] | undefined} */
  const lookup = (lang, key) => {
    const cacheKey = `${lang}\u0000${key}`;
    const cached = parsed.get(cacheKey);
    if (cached) return cached;
    const source = options.catalogs[lang]?.[key];
    if (source === undefined) return undefined;
    const nodes = parseMessage(source);
    parsed.set(cacheKey, nodes);
    return nodes;
  };

  return {
    get locale() {
      return locale;
    },
    /** @param {string} next */
    setLocale(next) {
      if (next in options.catalogs) locale = next;
    },
    /**
     * The text for `key` in the current language (the fallback language when it is missing), with `params` filled in.
     * @param {string} key
     * @param {Record<string, unknown>} [params]
     */
    t(key, params = {}) {
      const own = lookup(locale, key);
      const nodes = own ?? lookup(fallback, key);
      if (!nodes) {
        missing.add(key);
        return key;
      }
      return formatNodes(nodes, params, own ? locale : fallback);
    },
    /** Keys asked for that no catalog has. */
    missing: () => [...missing],
    locales: () => Object.keys(options.catalogs),
  };
}

/**
 * The language to start in: the saved choice, else the browser's, else the fallback.
 * @param {string | null | undefined} saved
 * @param {readonly string[]} browser
 * @param {readonly string[]} available
 * @param {string} [fallback]
 */
export function pickLocale(saved, browser, available, fallback = "en") {
  if (saved && available.includes(saved)) return saved;
  for (const tag of browser) {
    const lower = tag.toLowerCase();
    const base = lower.split("-")[0];
    const hit = available.find((l) => l === lower || l === base);
    if (hit) return hit;
  }
  return fallback;
}

/**
 * A size in bytes as readers expect to see it, in their own digits.
 * @param {number} bytes
 * @param {string} locale
 */
export function formatBytes(bytes, locale) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`;
}
