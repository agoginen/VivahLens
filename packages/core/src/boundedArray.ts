import { z } from "zod";

/**
 * An array schema that refuses an oversized array before looking inside it. Zod checks `.max()` only after it has parsed
 * every element, and records an issue for each element that fails, so a 256 KB request of empty objects makes a server
 * allocate about half a million issues (130 MB) before answering "too many" (zod advisory GHSA-mrhx-c7xc-m3w5, which
 * is fixed only in zod 4). Use it for every array that comes from outside, whatever its size cap.
 */
export function boundedArray<T extends z.ZodTypeAny>(item: T, max: number, min = 0) {
  return z
    .custom<unknown[]>((value) => Array.isArray(value) && value.length <= max, { message: `Expected an array of at most ${max} items` })
    .pipe(z.array(item).min(min));
}
