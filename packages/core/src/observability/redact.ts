export const REDACTED = "[redacted]";

export interface RedactOptions {
  /** The user's home folder; every path under it is shown as `~`, so a log does not carry the account name. */
  home?: string;
  /** A string longer than this is replaced by its length. Nothing legitimate in a log is this long; image data is. */
  maxString?: number;
  maxDepth?: number;
  maxArray?: number;
  /** Applied to every string after it has been scrubbed: the support bundle uses it to replace names with stand-ins. */
  transform?(text: string): string;
}

const DEFAULTS = { maxString: 400, maxDepth: 6, maxArray: 50 } as const;

/** Words that make a field's value a secret whatever it holds. `inputTokens` is not one (that is a count, and plural). */
const SECRET_WORDS = /\b(token|secret|passwords?|passwd|authorization|cookies?|credentials?|bearer|signature|api ?key|license ?key|licence ?key|private ?key|access ?key|signing ?key)\b/;

function words(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

/** Whether a field name says its value is a secret (`apiKey`, `refresh_token`, `Authorization`), not merely a count of something. */
export function isSecretKey(key: string): boolean {
  return SECRET_WORDS.test(words(key));
}

const VALUE_PATTERNS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\bVL-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?/g, REDACTED],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[credentials]@"],
  [/([?&](?:t|token|key|api[-_]?key|sig|signature|code|x-amz-[a-z-]+)=)[^&\s"']+/gi, `$1${REDACTED}`],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[email]"],
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A folder part of a path: a drive letter or ~ or a leading slash (not part of a URL or a word), then folders up to the
 * last slash. A folder name may contain spaces, but not run into the start of another path.
 */
const DIRECTORY_PREFIX = /(?:[A-Za-z]:[\\/]|~[\\/]|(?<![:/\w.])\/)(?:(?:(?!\s(?:[A-Za-z]:[\\/]|~[\\/]|\/))[^\\/"'<>|:*?\r\n])+[\\/])+/g;

/**
 * Paths with their folders taken off, leaving the file name: a support bundle needs to know which kind of file failed,
 * not that it was in a client's folder. URLs are left alone.
 */
export function stripDirectories(text: string): string {
  return text.replace(DIRECTORY_PREFIX, "<dir>/");
}

/**
 * The text with secrets, addresses and the account's home folder taken out. Used on every logged string and on
 * everything that goes into a support bundle.
 */
export function scrubText(text: string, opts: Pick<RedactOptions, "home"> = {}): string {
  let out = text;
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement);
  if (opts.home && opts.home.length > 3) {
    const home = opts.home.replace(/[\\/]+$/, "");
    // Either slash style, any case on Windows paths.
    const parts = home.split(/[\\/]+/).filter(Boolean).map(escapeRegExp);
    const lead = /^[\\/]/.test(home) ? "[\\\\/]" : "";
    out = out.replace(new RegExp(`${lead}${parts.join("[\\\\/]+")}(?=[\\\\/]|$|\\b)`, "gi"), "~");
  }
  out = out.replace(/([A-Za-z]:\\Users\\)[^\\\s"']+/gi, "$1<user>").replace(/(\/(?:Users|home)\/)[^/\s"']+/g, "$1<user>");
  return out;
}

/**
 * A copy of a value that is safe to write to a log or a support bundle: secrets by field name or by shape are replaced,
 * long strings (image data) and binary are reduced to their size, errors to name, code and message, and the account's
 * home folder to `~`. Nothing here ever throws on an odd value.
 */
export function redactValue(value: unknown, opts: RedactOptions = {}): unknown {
  const limits = { ...DEFAULTS, ...opts };
  const seen = new WeakSet<object>();
  const text = (s: string): string => {
    const scrubbed = scrubText(s, opts);
    return opts.transform ? opts.transform(scrubbed) : scrubbed;
  };

  const walk = (v: unknown, depth: number, key?: string): unknown => {
    if (key !== undefined && isSecretKey(key)) return v === undefined || v === null ? v : REDACTED;
    if (key === "dataBase64") return "[omitted image data]";
    switch (typeof v) {
      case "string":
        return v.length > limits.maxString ? `[omitted: ${v.length} characters]` : text(v);
      case "number":
      case "boolean":
      case "undefined":
        return v;
      case "bigint":
        return v.toString();
      case "symbol":
      case "function":
        return undefined;
    }
    if (v === null) return null;
    if (v instanceof Uint8Array) return `[binary: ${v.byteLength} bytes]`;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? "[invalid date]" : v.toISOString();
    if (v instanceof Error) {
      const code = (v as { code?: unknown }).code;
      return { name: v.name, ...(typeof code === "string" && { code }), message: text(v.message.length > limits.maxString ? `${v.message.slice(0, limits.maxString)}…` : v.message) };
    }
    const obj = v as object;
    if (seen.has(obj)) return "[circular]";
    if (depth >= limits.maxDepth) return "[…]";
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        const head = obj.slice(0, limits.maxArray).map((item) => walk(item, depth + 1));
        return obj.length > limits.maxArray ? [...head, `[+${obj.length - limits.maxArray} more]`] : head;
      }
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(obj)) {
        const cleaned = walk(item, depth + 1, k);
        if (cleaned !== undefined) out[k] = cleaned;
      }
      return out;
    } finally {
      seen.delete(obj);
    }
  };
  return walk(value, 0);
}
