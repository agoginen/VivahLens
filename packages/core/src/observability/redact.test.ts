import { describe, expect, it } from "vitest";
import { isSecretKey, redactValue, REDACTED, scrubText, stripDirectories } from "./redact.js";

describe("which field names hold secrets", () => {
  it("catches the usual spellings, whatever the casing or separator", () => {
    for (const key of ["apiKey", "api_key", "x-api-key", "API-KEY", "Authorization", "refreshToken", "entitlementToken", "access_token", "password", "clientSecret", "licenseKey", "privateKey", "Set-Cookie", "signature", "bearer", "credentials"]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it("leaves counts and ordinary fields alone, including the ones that merely contain a secret-sounding word", () => {
    for (const key of ["inputTokens", "outputTokens", "tokens", "totalTokens", "monkey", "keyboard", "photos", "recipeHash", "provider", "keyCount", "tokenizer"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe("scrubbing text", () => {
  it("removes keys, tokens and credentials wherever they appear in a sentence", () => {
    const text = [
      "request with sk-proj-abcdefghijklmnop1234567890 failed",
      "key AIzaSyA1234567890abcdefghijklmnopqrstuv rejected",
      "Authorization: Bearer abcDEF123456.-_~+/=",
      "licence VL-ABCDE-12345-FGHIJ-67890 expired",
      "token eyJhbGciOiJFZERTQSJ9.eyJhY2NvdW50SWQiOiJhIn0.c2lnbmF0dXJl end",
      "proxy http://user:hunter2@proxy.example:8080/path",
    ].join(" | ");
    const out = scrubText(text);
    expect(out).not.toMatch(/sk-proj|AIzaSy|abcDEF123456|VL-ABCDE|eyJhbGci|hunter2/);
    expect(out).toContain("Bearer [redacted]");
    expect(out).toContain("http://[credentials]@proxy.example:8080/path");
  });

  it("removes secret query parameters from URLs but keeps the rest, so the address is still useful", () => {
    expect(scrubText("GET http://127.0.0.1:4500/api/items?t=abc123XYZ&page=2")).toBe("GET http://127.0.0.1:4500/api/items?t=[redacted]&page=2");
    expect(scrubText("https://x.example/f?X-Amz-Signature=deadbeef&X-Amz-Expires=300&key=k1")).toBe("https://x.example/f?X-Amz-Signature=[redacted]&X-Amz-Expires=[redacted]&key=[redacted]");
  });

  it("removes email addresses", () => {
    expect(scrubText("sent to jane.doe+work@studio.example.com today")).toBe("sent to [email] today");
  });

  it("shows paths under the home folder as ~, in either slash style and any case on Windows", () => {
    const home = "C:\\Users\\Jane Doe";
    expect(scrubText("C:\\Users\\Jane Doe\\Pictures\\wedding\\a.cr3", { home })).toBe("~\\Pictures\\wedding\\a.cr3");
    expect(scrubText("c:/users/jane doe/Pictures/a.cr3", { home })).toBe("~/Pictures/a.cr3");
    expect(scrubText("failed in C:\\Users\\Jane Doe", { home })).toBe("failed in ~");
    expect(scrubText("/home/jane/pics/a.cr3", { home: "/home/jane" })).toBe("~/pics/a.cr3");
    expect(scrubText("/home/janet/pics", { home: "/home/jane" })).toBe("/home/<user>/pics");
  });

  it("hides the account name in any user folder even when the home folder is not known", () => {
    expect(scrubText("C:\\Users\\SomeoneElse\\x.jpg")).toBe("C:\\Users\\<user>\\x.jpg");
    expect(scrubText("/Users/someone/x.jpg and /home/other/y.jpg")).toBe("/Users/<user>/x.jpg and /home/<user>/y.jpg");
  });
});

describe("stripping folders from paths", () => {
  it("keeps the file name and drops the folders, for Windows, home-relative and POSIX paths, including folders with spaces", () => {
    expect(stripDirectories("could not read D:\\Weddings\\Sharma 2026\\RAW\\IMG_001.CR3 twice")).toBe("could not read <dir>/IMG_001.CR3 twice");
    expect(stripDirectories("wrote ~\\Pictures\\out\\a.jpg and ~/Pictures/b.jpg")).toBe("wrote <dir>/a.jpg and <dir>/b.jpg");
    expect(stripDirectories("failed: /mnt/shoots/sharma/IMG_002.NEF (EIO)")).toBe("failed: <dir>/IMG_002.NEF (EIO)");
    expect(stripDirectories("/Volumes/Card/DCIM/IMG_3.DNG")).toBe("<dir>/IMG_3.DNG");
  });

  it("leaves URLs, fractions and plain words alone", () => {
    for (const text of ["POST https://api.openai.com/v1/chat/completions failed", "ratio 3/4 and and/or", "http://127.0.0.1:4500/api/items", "no paths here"]) {
      expect(stripDirectories(text)).toBe(text);
    }
  });
});

describe("redacting a value", () => {
  it("passes every string through a transform after scrubbing it, including error messages, but not keys or numbers", () => {
    const out = redactValue({ a: "client Sharma", n: 5, err: new Error("failed for Sharma"), list: ["Sharma"], Sharma: "key stays" }, { transform: (s) => s.replaceAll("Sharma", "X") });
    expect(out).toEqual({ a: "client X", n: 5, err: { name: "Error", message: "failed for X" }, list: ["X"], Sharma: "key stays" });
    // Scrubbing comes first, so the transform never sees a secret.
    const seen: string[] = [];
    redactValue("sk-abcdefghijklmnopqrst", { transform: (s) => (seen.push(s), s) });
    expect(seen).toEqual(["[redacted]"]);
  });
  it("replaces secrets by field name, however deep, and keeps counts", () => {
    const out = redactValue({ provider: "openai", apiKey: "sk-123", usage: { inputTokens: 10, outputTokens: 4 }, headers: { Authorization: "Bearer abcdefghijkl", "content-type": "json" }, nested: [{ refreshToken: "r" }] });
    expect(out).toEqual({ provider: "openai", apiKey: REDACTED, usage: { inputTokens: 10, outputTokens: 4 }, headers: { Authorization: REDACTED, "content-type": "json" }, nested: [{ refreshToken: REDACTED }] });
  });

  it("never lets image data through: long strings, base64 fields and binary become their size", () => {
    const image = "A".repeat(50_000);
    const out = redactValue({ preview: { mediaType: "image/jpeg", dataBase64: "short" }, blob: image, bytes: new Uint8Array(1234), note: "fine" }) as Record<string, unknown>;
    expect(out).toEqual({ preview: { mediaType: "image/jpeg", dataBase64: "[omitted image data]" }, blob: "[omitted: 50000 characters]", bytes: "[binary: 1234 bytes]", note: "fine" });
    expect(JSON.stringify(out)).not.toContain("AAAAAAAA");
  });

  it("describes an error by name, code and scrubbed message, without its stack", () => {
    const err = Object.assign(new Error("could not read C:\\Users\\Jane\\a.cr3 with key sk-abcdefghijklmnopqrst"), { code: "ASSET_UNREADABLE" });
    const out = redactValue({ err }, { home: "C:\\Users\\Jane" }) as { err: Record<string, unknown> };
    expect(out.err).toEqual({ name: "Error", code: "ASSET_UNREADABLE", message: "could not read ~\\a.cr3 with key [redacted]" });
    expect(JSON.stringify(out)).not.toContain("at ");
  });

  it("copes with circular structures, deep nesting, huge arrays, odd types, and leaves its input alone", () => {
    const loop: Record<string, unknown> = { name: "a" };
    loop.self = loop;
    expect(redactValue(loop)).toEqual({ name: "a", self: "[circular]" });

    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 10; i++) deep = { next: deep };
    expect(JSON.stringify(redactValue(deep))).toContain("[…]");

    expect(redactValue({ list: Array.from({ length: 80 }, (_, i) => i) })).toMatchObject({ list: expect.arrayContaining(["[+30 more]"]) });
    expect(redactValue({ big: 10n, fn: () => 1, sym: Symbol("x"), when: new Date(Date.UTC(2026, 0, 2)), nothing: null, missing: undefined })).toEqual({ big: "10", when: "2026-01-02T00:00:00.000Z", nothing: null });

    const input = { apiKey: "secret", path: "C:\\Users\\Jane\\x" };
    redactValue(input, { home: "C:\\Users\\Jane" });
    expect(input).toEqual({ apiKey: "secret", path: "C:\\Users\\Jane\\x" });
  });

  it("keeps a missing secret missing, so a log shows that no key was set", () => {
    expect(redactValue({ apiKey: undefined, token: null })).toEqual({ token: null });
  });
});
