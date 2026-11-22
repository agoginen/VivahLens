import { describe, expect, it } from "vitest";
import { embeddedAsset, embeddedAssetFrom, type SeaModule } from "./assets.js";

const sea = (assets: Record<string, string>, isSea = true): SeaModule => ({
  isSea: () => isSea,
  getAsset(key) {
    if (!(key in assets)) throw Object.assign(new Error(`no asset ${key}`), { code: "ERR_SEA_ASSET_NOT_FOUND" });
    const bytes = new TextEncoder().encode(assets[key]);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
});

describe("embeddedAssetFrom", () => {
  it("returns the bytes of an embedded file", () => {
    expect(embeddedAssetFrom(sea({ "review/client/app.js": "alert(1)" }), "review/client/app.js")?.toString("utf8")).toBe("alert(1)");
  });

  it("returns a copy, so a caller cannot change what the next one reads", () => {
    const executable = sea({ k: "abc" });
    embeddedAssetFrom(executable, "k")!.fill(0);
    expect(embeddedAssetFrom(executable, "k")?.toString("utf8")).toBe("abc");
  });

  it("says nothing is embedded for a file the build does not hold", () => {
    expect(embeddedAssetFrom(sea({}), "missing")).toBeUndefined();
  });

  it("looks at nothing when this is not the single-file build, even if the module offers a file", () => {
    expect(embeddedAssetFrom(sea({ k: "abc" }, false), "k")).toBeUndefined();
  });

  it("copes with a Node that has no node:sea to ask", () => {
    expect(embeddedAssetFrom(undefined, "k")).toBeUndefined();
  });
});

describe("embeddedAsset", () => {
  it("finds nothing when running as an ordinary program", () => {
    expect(embeddedAsset("review/client/app.js")).toBeUndefined();
  });
});
