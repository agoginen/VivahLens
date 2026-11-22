import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boundedArray } from "./boundedArray.js";

describe("boundedArray", () => {
  it("parses an array within its limits exactly as z.array does, transforms included", () => {
    const schema = boundedArray(z.string().trim(), 3, 1);
    expect(schema.parse([" a ", "b"])).toEqual(["a", "b"]);
    expect(schema.parse(["x", "y", "z"])).toHaveLength(3);
  });

  it("refuses an oversized array with one issue, without parsing a single element", () => {
    let parsed = 0;
    const schema = boundedArray(z.string().refine(() => (parsed++, false)), 5);
    const result = schema.safeParse(Array.from({ length: 100_000 }, () => ({})));
    expect(result.success).toBe(false);
    expect(parsed).toBe(0);
    expect(result.error!.issues).toHaveLength(1);
    expect(result.error!.issues[0]!.message).toBe("Expected an array of at most 5 items");
  });

  it("is the cheap alternative to what it replaces: z.array().max() parses and reports on every element first", () => {
    const element = z.object({ a: z.string(), b: z.number() }).strict();
    const input = Array.from({ length: 2000 }, () => ({}));
    expect(z.array(element).max(5).safeParse(input).error!.issues.length).toBeGreaterThan(2000);
    expect(boundedArray(element, 5).safeParse(input).error!.issues).toHaveLength(1);
  });

  it("refuses what is not an array, with the same single issue", () => {
    const schema = boundedArray(z.string(), 3);
    for (const value of [{}, "abc", null, undefined, 7, { length: 2, 0: "a", 1: "b" }]) {
      const issues = schema.safeParse(value).error?.issues;
      expect(issues, JSON.stringify(value)).toHaveLength(1);
    }
  });

  it("still reports which element within the limit is wrong, by position", () => {
    const schema = z.object({ events: boundedArray(z.object({ photos: z.number() }), 10) });
    const issues = schema.safeParse({ events: [{ photos: 1 }, { photos: "many" }] }).error!.issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(["events", 1, "photos"]);
  });

  it("enforces the minimum after the bound", () => {
    expect(boundedArray(z.string(), 3, 1).safeParse([]).success).toBe(false);
    expect(boundedArray(z.string(), 3).safeParse([]).success).toBe(true);
  });

  it("works as an optional field inside an object", () => {
    const schema = z.object({ adapters: boundedArray(z.string(), 2).optional() }).strict();
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ adapters: ["a"] })).toEqual({ adapters: ["a"] });
    expect(schema.safeParse({ adapters: ["a", "b", "c"] }).success).toBe(false);
  });
});
