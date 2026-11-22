import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RecipeAdjustmentsSchema } from "@vivahlens/core";
import { FIELDS, formatValue, getValue, setValue } from "./fields.js";
import { FILTERS, countByFilter, defaultFilter, filterItems } from "./filters.js";
import { createI18n, formatBytes, formatNodes, parseMessage, pickLocale } from "./i18n.js";
import { columnsFor, gridMove, settleFocus } from "./nav.js";
import { reviewPage } from "../ui.js";

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const en = JSON.parse(read("./locales/en.json")) as Record<string, string>;
const hi = JSON.parse(read("./locales/hi.json")) as Record<string, string>;
const i18n = (locale: string) => createI18n({ locale, catalogs: { en, hi } });

describe("messages", () => {
  it("fills in values, formats numbers for the reader, and leaves unknown values visible", () => {
    const t = createI18n({ locale: "en", catalogs: { en: { a: "Hello {name}", n: "{count, number} files", m: "{missing} stays" } } }).t;
    expect(t("a", { name: "Asha" })).toBe("Hello Asha");
    expect(t("n", { count: 1234567 })).toBe("1,234,567 files");
    expect(t("m", {})).toBe("{missing} stays");
    expect(createI18n({ locale: "hi", fallback: "hi", catalogs: { hi: { n: "{count, number}" } } }).t("n", { count: 1234567 })).toBe("12,34,567");
  });

  it("chooses a plural by the language's own rules: Hindi treats 0 like 1, English does not", () => {
    const message = "{n, plural, one {# photo} other {# photos}}";
    const nodes = parseMessage(message);
    expect([0, 1, 2, 5].map((n) => formatNodes(nodes, { n }, "en"))).toEqual(["0 photos", "1 photo", "2 photos", "5 photos"]);
    expect([0, 1, 2, 5].map((n) => formatNodes(parseMessage("{n, plural, one {एक} other {कई}}"), { n }, "hi"))).toEqual(["एक", "एक", "कई", "कई"]);
    expect(formatNodes(parseMessage("{n, plural, =0 {none} one {# photo} other {# photos}}"), { n: 0 }, "en")).toBe("none");
    expect(formatNodes(nodes, { n: 1500 }, "en")).toBe("1,500 photos");
    expect(formatNodes(nodes, {}, "en")).toBe("{n}");
  });

  it("supports a plural inside a message with other text around it, and # only means the number inside a plural", () => {
    const t = createI18n({ locale: "en", catalogs: { en: { x: "Done: {a, plural, one {# photo exported} other {# photos exported}}, {b, number} approved (#1)" } } }).t;
    expect(t("x", { a: 1, b: 12 })).toBe("Done: 1 photo exported, 12 approved (#1)");
    expect(t("x", { a: 3, b: 0 })).toBe("Done: 3 photos exported, 0 approved (#1)");
  });

  it("refuses malformed messages instead of showing half of one", () => {
    for (const bad of ["{oops", "stray }", "{n, plural, one {x}}", "{n, select, a {b} other {c}}", "{n, plural, one x other {y}}", "{n, plural, other {unclosed}"]) {
      expect(() => parseMessage(bad), bad).toThrow();
    }
  });

  it("falls back to English for a missing translation, and to the key itself when no language has one, remembering what was missing", () => {
    const t = createI18n({ locale: "hi", catalogs: { en: { a: "English only", b: "Both" }, hi: { b: "दोनों" } } });
    expect(t.t("a")).toBe("English only");
    expect(t.t("b")).toBe("दोनों");
    expect(t.t("nowhere")).toBe("nowhere");
    expect(t.missing()).toEqual(["nowhere"]);
    t.setLocale("fr");
    expect(t.locale).toBe("hi");
    t.setLocale("en");
    expect(t.t("b")).toBe("Both");
  });

  it("starts in the saved language, else the browser's, else English", () => {
    const available = ["en", "hi"];
    expect(pickLocale("hi", ["en-GB"], available)).toBe("hi");
    expect(pickLocale("xx", ["en-GB"], available)).toBe("en");
    expect(pickLocale(null, ["fr-FR", "hi-IN", "en"], available)).toBe("hi");
    expect(pickLocale(null, ["HI"], available)).toBe("hi");
    expect(pickLocale(null, ["fr"], available)).toBe("en");
    expect(pickLocale(undefined, [], available)).toBe("en");
  });

  it("shows sizes in a sensible unit", () => {
    expect(formatBytes(0, "en")).toBe("0 B");
    expect(formatBytes(1536, "en")).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024, "en")).toBe("5 MB");
    expect(formatBytes(3 * 1024 ** 3, "en")).toBe("3 GB");
    expect(formatBytes(5 * 1024 ** 5, "en")).toBe("5,242,880 GB");
  });
});

describe("translations", () => {
  const args = (source: string): string[] => {
    const found: string[] = [];
    const walk = (nodes: ReturnType<typeof parseMessage>) => {
      for (const n of nodes) {
        if (n.type === "arg") found.push(`arg:${n.name}`);
        else if (n.type === "number") found.push(`number:${n.name}`);
        else if (n.type === "plural") {
          found.push(`plural:${n.name}`);
          for (const [selector, inner] of n.cases) {
            expect(["zero", "one", "two", "few", "many", "other"].includes(selector) || /^=\d+$/.test(selector), `${selector} in ${source}`).toBe(true);
            walk(inner);
          }
        }
      }
    };
    walk(parseMessage(source));
    return [...new Set(found)].sort();
  };

  it("has the same messages in every language", () => {
    expect(Object.keys(hi).sort()).toEqual(Object.keys(en).sort());
  });

  it("parses, and each translation uses the same values as the English it translates", () => {
    for (const key of Object.keys(en)) expect(args(hi[key]!), key).toEqual(args(en[key]!));
  });

  it("is really translated: every Hindi message has Devanagari text", () => {
    for (const [key, value] of Object.entries(hi)) expect(/[\u0900-\u097F]/.test(value), key).toBe(true);
  });

  it("formats every message in both languages without leaving a value unfilled", () => {
    const values = { job: "j1", adapter: "xmp", message: "m", count: 2, exported: 2, approved: 1, failed: 0, label: "L", name: "IMG_1", fields: "f", reason: "r", note: "n", source: "s", images: 2, size: "1 MB", provider: "p", calls: 2, px: "2,048" };
    for (const locale of ["en", "hi"]) {
      const t = i18n(locale);
      for (const key of Object.keys(en)) expect(t.t(key, values), `${locale} ${key}`).not.toMatch(/[{}]/);
    }
  });

  it("covers every key the page asks for, including the ones it builds from a state, field or tab name", () => {
    const script = read("./app.js");
    const literal = [...script.matchAll(/["'`]((?:app|filter|state|reason|action|view|detail|source|field|note|status|privacy|help)\.[A-Za-z-]+)["'`]/g)].map((m) => m[1]!);
    expect(literal.length).toBeGreaterThan(40);
    for (const key of new Set(literal)) expect(en, key).toHaveProperty([key]);
    for (const f of FILTERS) expect(en, `filter.${f.id}`).toHaveProperty([`filter.${f.id}`]);
    for (const field of FIELDS) expect(en, `field.${field.id}`).toHaveProperty([`field.${field.id}`]);
    for (const state of ["queued", "culled", "style-matched", "recipe-generated", "applying", "review", "approved", "exported", "delivered", "rejected", "failed"]) expect(en, state).toHaveProperty([`state.${state}`]);
    for (const reason of ["blurry", "duplicate", "duplicate-file"]) expect(en, reason).toHaveProperty([`reason.${reason}`]);
    for (const source of ["llm", "override", "cache"]) expect(en, source).toHaveProperty([`source.${source}`]);
    for (const reason of ["expired", "subscription", "device"]) expect(en, reason).toHaveProperty([`editing.paused.${reason}`]);
    expect(script).toContain("`editing.paused.${editing.reason}`");
  });
});

describe("moving around the grid", () => {
  // 10 photos, 4 to a row:  0 1 2 3 / 4 5 6 7 / 8 9
  const move = (index: number, key: string, ctrl = false) => gridMove(index, key, 4, 10, { ctrl });

  it("moves one card or one row, and stops at the edges", () => {
    expect(move(5, "ArrowRight")).toBe(6);
    expect(move(5, "ArrowLeft")).toBe(4);
    expect(move(5, "ArrowDown")).toBe(9);
    expect(move(5, "ArrowUp")).toBe(1);
    expect(move(9, "ArrowRight")).toBe(9);
    expect(move(0, "ArrowLeft")).toBe(0);
    expect(move(1, "ArrowUp")).toBe(0);
  });

  it("goes down onto a short last row, and stays when there is no row below", () => {
    expect(move(3, "ArrowDown")).toBe(7);
    expect(move(7, "ArrowDown")).toBe(9);
    expect(move(9, "ArrowDown")).toBe(9);
    expect(move(8, "ArrowDown")).toBe(8);
  });

  it("jumps to the ends of a row, or of the whole grid with Ctrl, and by pages", () => {
    expect(move(5, "Home")).toBe(4);
    expect(move(5, "End")).toBe(7);
    expect(move(9, "End")).toBe(9);
    expect(move(5, "Home", true)).toBe(0);
    expect(move(5, "End", true)).toBe(9);
    expect(move(0, "PageDown")).toBe(9);
    expect(move(9, "PageUp")).toBe(0);
  });

  it("ignores other keys, copes with an empty or one-card grid, and keeps the index inside the list", () => {
    expect(move(5, "x")).toBe(5);
    expect(gridMove(0, "ArrowRight", 4, 0)).toBe(0);
    expect(gridMove(0, "ArrowDown", 4, 1)).toBe(0);
    expect(gridMove(7, "x", 4, 3)).toBe(2);
    expect(gridMove(2, "ArrowDown", 1, 5)).toBe(3);
  });

  it("counts columns from the width, never fewer than one", () => {
    expect(columnsFor(1000, 260, 12)).toBe(3);
    expect(columnsFor(260, 260, 12)).toBe(1);
    expect(columnsFor(100, 260, 12)).toBe(1);
    expect(columnsFor(0, 260, 12)).toBe(1);
    expect(columnsFor(1620, 260, 12)).toBe(6);
    expect(columnsFor(1608, 260, 12)).toBe(5);
  });

  it("keeps the focus on a photo after the list shrinks, or on nothing when it is empty", () => {
    expect(settleFocus(3, 10)).toBe(3);
    expect(settleFocus(9, 4)).toBe(3);
    expect(settleFocus(-2, 4)).toBe(0);
    expect(settleFocus(2, 0)).toBe(-1);
  });
});

describe("adjustment fields", () => {
  const schemaAccepts = (field: (typeof FIELDS)[number], value: number) => RecipeAdjustmentsSchema.safeParse(setValue({}, { ...field, min: -1e9, max: 1e9 }, value)).success;

  it("has ranges the recipe schema accepts, so the page can never send a value the server refuses, and offers each field's whole range", () => {
    for (const field of FIELDS) {
      expect(schemaAccepts(field, field.min), `${field.id} min`).toBe(true);
      expect(schemaAccepts(field, field.max), `${field.id} max`).toBe(true);
      expect(field.fallback).toBeGreaterThanOrEqual(field.min);
      expect(field.fallback).toBeLessThanOrEqual(field.max);
      // The temperature slider stops at 12000 K, well inside the 2000 to 50000 K the schema allows, because nothing beyond is useful on a slider.
      if (field.id === "tempK") continue;
      expect(schemaAccepts(field, field.min - field.step), `${field.id} below min`).toBe(false);
      expect(schemaAccepts(field, field.max + field.step), `${field.id} above max`).toBe(false);
    }
  });

  it("reads and writes nested values without touching the original, and keeps values in range", () => {
    const temp = FIELDS.find((f) => f.id === "tempK")!;
    const original = { exposure: 0.5, whiteBalance: { tint: 4 } };
    const changed = setValue(original, temp, 6200);
    expect(changed).toEqual({ exposure: 0.5, whiteBalance: { tint: 4, tempK: 6200 } });
    expect(original).toEqual({ exposure: 0.5, whiteBalance: { tint: 4 } });
    expect(getValue(changed, temp)).toBe(6200);
    expect(getValue({}, temp)).toBeUndefined();
    expect(getValue({ whiteBalance: { tempK: "warm" } }, temp)).toBeUndefined();
    expect(setValue({}, temp, 99999)).toEqual({ whiteBalance: { tempK: 12000 } });
    expect(setValue({ whiteBalance: null }, temp, 5000)).toEqual({ whiteBalance: { tempK: 5000 } });
    expect(setValue({}, FIELDS[0]!, -50)).toEqual({ exposure: -5 });
  });

  it("shows values the way readers expect, with a sign for changes and none for a temperature", () => {
    const exposure = FIELDS.find((f) => f.id === "exposure")!;
    const temp = FIELDS.find((f) => f.id === "tempK")!;
    const contrast = FIELDS.find((f) => f.id === "contrast")!;
    expect(formatValue(0.5, exposure, "en")).toBe("+0.50");
    expect(formatValue(-0.25, exposure, "en")).toBe("-0.25");
    expect(formatValue(0, exposure, "en")).toBe("0.00");
    expect(formatValue(5200, temp, "en")).toBe("5,200");
    expect(formatValue(12, contrast, "hi")).toBe("+12");
  });
});

describe("tabs", () => {
  const items = [
    { id: "a", state: "review" }, { id: "b", state: "review", retouch: true }, { id: "c", state: "approved" }, { id: "d", state: "exported" },
    { id: "e", state: "delivered" }, { id: "f", state: "rejected" }, { id: "g", state: "failed" }, { id: "h", state: "culled" },
  ];

  it("sorts photos into the tabs a photographer expects, and every photo is under All", () => {
    expect(filterItems(items, "review").map((i) => i.id)).toEqual(["a", "b"]);
    expect(filterItems(items, "approved").map((i) => i.id)).toEqual(["c", "d", "e"]);
    expect(filterItems(items, "rejected").map((i) => i.id)).toEqual(["f"]);
    expect(filterItems(items, "failed").map((i) => i.id)).toEqual(["g"]);
    expect(filterItems(items, "retouch").map((i) => i.id)).toEqual(["b"]);
    expect(filterItems(items, "all")).toHaveLength(8);
    expect(filterItems(items, "no-such-tab")).toHaveLength(8);
    expect(countByFilter(items)).toEqual({ review: 2, approved: 3, rejected: 1, failed: 1, retouch: 1, all: 8 });
  });

  it("opens on the tab with photos to review, else the first with any, else All", () => {
    expect(defaultFilter(items)).toBe("review");
    expect(defaultFilter(items.slice(2))).toBe("approved");
    expect(defaultFilter([{ id: "x", state: "rejected" }])).toBe("rejected");
    expect(defaultFilter([{ id: "x", state: "queued" }])).toBe("all");
    expect(defaultFilter([])).toBe("all");
  });
});

describe("the page is usable", () => {
  const html = reviewPage("t");
  const idsInHtml = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
  // Created by the script when a dialog or photo is opened.
  const madeByScript = new Set(["split", "retouch-note", "detail-title", "privacy-dialog", "help-dialog"]);

  it("has every element the script looks for", () => {
    const script = read("./app.js");
    const wanted = [...script.matchAll(/\$\("([a-z-]+)"\)/g)].map((m) => m[1]!);
    expect(wanted.length).toBeGreaterThan(10);
    for (const id of new Set(wanted)) expect(idsInHtml.has(id) || madeByScript.has(id), `#${id}`).toBe(true);
  });

  it("has landmarks, a skip link that leads somewhere, a language, and a live region", () => {
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toContain("<title>");
    expect(html).toMatch(/<header[^>]*>/);
    expect(html).toMatch(/<nav[^>]*id="filters"/);
    expect(html).toMatch(/<main>/);
    const skip = /<a class="skip" id="skip" href="#([^"]+)"/.exec(html)!;
    expect(idsInHtml.has(skip[1]!)).toBe(true);
    expect(html).toMatch(/id="live" role="status" aria-live="polite"/);
    expect(html).toMatch(/<label><span id="lang-label">[^<]*<\/span> <select id="lang">/);
    expect(html).toMatch(/<dialog id="detail">/);
    expect(html).toMatch(/id="help-button" aria-label=/);
  });

  it("puts text into the DOM only as text, never as markup", () => {
    const script = read("./app.js");
    expect(script).not.toMatch(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });

  it("always gives a toggle button an explicit pressed state, true or false, because an absent one means it is not a toggle", () => {
    const uses = [...read("./app.js").matchAll(/"aria-pressed":\s*([^,}]+)/g)].map((m) => m[1]!.trim());
    expect(uses.length).toBeGreaterThan(3);
    for (const value of uses) expect(value, value).toMatch(/^String\(/);
  });
});

describe("colours meet WCAG 2.2 AA contrast", () => {
  const css = read("./app.css");
  const colour = (name: string) => {
    const hex = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)?.[1];
    if (!hex) throw new Error(`--${name} not found`);
    return hex;
  };
  const channel = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  const pressed = (selector: string) => new RegExp(`${selector.replace(/[[\]".]/g, "\\$&")}[^}]*background:\\s*(#[0-9a-fA-F]{6})`).exec(css)![1]!;

  it("keeps text at 4.5:1 or better on every surface it appears on", () => {
    const surfaces = ["bg", "surface", "surface-2"];
    for (const surface of surfaces) {
      for (const text of ["text", "muted", "accent-link", "good", "warn", "bad"]) expect(ratio(colour(text), colour(surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(colour("accent-text"), colour("accent"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(colour("text"), pressed('button[aria-pressed="true"]'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(colour("text"), pressed('button.retouch[aria-pressed="true"]'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(colour("good"), pressed('button[aria-pressed="true"]'))).toBeGreaterThanOrEqual(3);
  });

  it("keeps the focus ring and the edges of controls at 3:1 or better against what they sit on", () => {
    for (const surface of ["bg", "surface", "surface-2"]) {
      expect(ratio(colour("focus"), colour(surface)), `focus on ${surface}`).toBeGreaterThanOrEqual(3);
      expect(ratio(colour("border"), colour(surface)), `border on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("gives controls a target at least 24 CSS pixels square, as WCAG 2.2 requires", () => {
    expect(css).toMatch(/button, select \{ min-height: 2\.5rem; min-width: 2\.5rem;/);
    expect(css).toMatch(/:focus-visible \{ outline: 3px solid var\(--focus\)/);
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
  });
});
