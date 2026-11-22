import { createHash, timingSafeEqual } from "node:crypto";

export type RandomBytes = (n: number) => Buffer;

export const sha256Hex = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

/** Constant-time string comparison that does not leak length (both sides are hashed first). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** Crockford base32 without I, L, O, U: no look-alike characters when a customer types the key. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KEY_PATTERN = /^VL(-[0-9A-HJKMNP-TV-Z]{5}){4}$/;

/** `VL-XXXXX-XXXXX-XXXXX-XXXXX`: 20 symbols = 100 bits of randomness. */
export function newLicenseKey(randomBytes: RandomBytes): string {
  let n = BigInt(`0x${randomBytes(13).toString("hex")}`) >> 4n; // 104 bits, keep 100
  const symbols: string[] = [];
  for (let i = 0; i < 20; i++) {
    symbols.unshift(ALPHABET[Number(n & 31n)]!);
    n >>= 5n;
  }
  const s = symbols.join("");
  return `VL-${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`;
}

/** Accepts the key as typed (any case, stray spaces) and returns the canonical form, or undefined if it cannot be a key. */
export function normalizeLicenseKey(input: string): string | undefined {
  const key = input.replace(/\s+/g, "").toUpperCase();
  return KEY_PATTERN.test(key) ? key : undefined;
}

export const newToken = (randomBytes: RandomBytes): string => randomBytes(32).toString("base64url");

export const newId = (prefix: string, randomBytes: RandomBytes): string => `${prefix}_${randomBytes(12).toString("base64url")}`;
