import { describe, expect, it } from "vitest";
import type { AssetRef } from "../adapters/editorAdapter.js";
import { exportNames } from "./names.js";

const at = (file: string): AssetRef => ({ id: file, kind: "photo", path: `/shoot/${file}` });
const namesOf = (files: string[]) => Object.fromEntries(exportNames(files.map(at)));

describe("exportNames", () => {
  it("keeps plain names for photos that do not collide", () => {
    expect(namesOf(["IMG_001.cr3", "IMG_002.cr3", "wedding day.NEF"])).toEqual({ "IMG_001.cr3": "IMG_001", "IMG_002.cr3": "IMG_002", "wedding day.NEF": "wedding day" });
  });

  it("gives the later of a RAW and JPEG pair its extension, so both can be exported", () => {
    expect(namesOf(["IMG_001.JPG", "IMG_001.CR3"])).toEqual({ "IMG_001.CR3": "IMG_001", "IMG_001.JPG": "IMG_001-jpg" });
  });

  it("does not depend on the order the photos are listed in", () => {
    const a = ["IMG_001.cr3", "IMG_001.jpg", "IMG_001.dng"];
    expect(namesOf(a)).toEqual(namesOf([...a].reverse()));
    expect(namesOf(a)).toEqual({ "IMG_001.cr3": "IMG_001", "IMG_001.dng": "IMG_001-dng", "IMG_001.jpg": "IMG_001-jpg" });
  });

  it("treats names that differ only in case as the same, as Windows and macOS do", () => {
    expect(namesOf(["IMG_001.CR3", "img_001.jpg"])).toEqual({ "IMG_001.CR3": "IMG_001", "img_001.jpg": "img_001-jpg" });
  });

  it("never produces a name that another photo already has, or that it produced for one before", () => {
    const names = namesOf(["a.cr3", "a.jpg", "a-jpg.cr3", "a.JPG"]);
    expect(Object.values(names).map((n) => n.toLowerCase()).sort()).toEqual([...new Set(Object.values(names).map((n) => n.toLowerCase()))].sort());
    expect(names["a-jpg.cr3"]).toBe("a-jpg");
    expect(names["a.cr3"]).toBe("a");
    expect(Object.values(names)).toHaveLength(4);
  });

  it("copes with a photo that has no extension", () => {
    expect(namesOf(["scan", "scan.tif"])).toEqual({ scan: "scan", "scan.tif": "scan-tif" });
  });
});
