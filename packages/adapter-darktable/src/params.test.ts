import { describe, expect, it } from "vitest";
import { cropParams, DEFAULT_EXPOSURE_EV, EXPOSURE, CROP, exposureParams, readCrop, readExposure } from "./params.js";

const bytes = (hex: string) => Buffer.from(hex, "hex");

describe("the exposure module's parameters", () => {
  it("are the 28 bytes darktable 5.6 reads: mode, black, exposure, deflicker percentile and target, then two flags, little endian", () => {
    const b = bytes(exposureParams(1.25));
    expect(b).toHaveLength(EXPOSURE.bytes);
    expect(EXPOSURE).toMatchObject({ operation: "exposure", modversion: 7 });
    expect(b.readInt32LE(0)).toBe(0); // manual exposure
    expect(b.readFloatLE(4)).toBeCloseTo(-0.000244140625, 12); // the raw-file default black level
    expect(b.readFloatLE(8)).toBe(1.25);
    expect(b.readFloatLE(12)).toBe(50);
    expect(b.readFloatLE(16)).toBe(-4);
    expect(b.readInt32LE(20)).toBe(1);
    expect(b.readInt32LE(24)).toBe(1);
  });

  it("match the +1 EV example worked out by hand from the struct in the research note", () => {
    expect(exposureParams(1)).toBe("00000000000080b90000803f00004842000080c00100000001000000");
  });

  it("are lowercase hex, because darktable refuses uppercase", () => {
    for (const ev of [-5, -0.35, 0.7, 1.05, 12]) expect(exposureParams(ev)).toMatch(/^[0-9a-f]{56}$/);
  });

  it("round to the nearest single-precision float, as the C struct does", () => {
    expect(readExposure(exposureParams(1.05))!.exposure).toBeCloseTo(1.05, 6);
    expect(readExposure(exposureParams(1.05))!.exposure).toBe(Math.fround(1.05));
  });

  it("add 0.7 EV to a recipe's exposure to stay level with darktable's own scene-referred default", () => {
    expect(DEFAULT_EXPOSURE_EV).toBe(0.7);
  });
});

describe("the crop module's parameters", () => {
  it("are the 24 bytes darktable 5.6 reads: left, top, right and bottom edges as fractions, then a free aspect ratio", () => {
    const b = bytes(cropParams({ left: 0.1, top: 0.2, right: 0.9, bottom: 0.8 }));
    expect(b).toHaveLength(CROP.bytes);
    expect(CROP).toMatchObject({ operation: "crop", modversion: 3 });
    expect([0, 4, 8, 12].map((o) => Math.fround(b.readFloatLE(o)))).toEqual([0.1, 0.2, 0.9, 0.8].map(Math.fround));
    expect(b.readInt32LE(16)).toBe(0);
    expect(b.readInt32LE(20)).toBe(0);
  });

  it("match the 5% border example worked out by hand from the struct in the research note", () => {
    expect(cropParams({ left: 0.05, top: 0.05, right: 0.95, bottom: 0.95 })).toBe("cdcc4c3dcdcc4c3d3333733f3333733f0000000000000000");
  });

  it("read back what was written", () => {
    const rect = { left: 0.25, top: 0.125, right: 0.75, bottom: 0.875 };
    expect(readCrop(cropParams(rect))).toEqual(rect);
  });
});

describe("reading parameters back", () => {
  it("refuses anything that is not a block of the right size in lowercase hex", () => {
    expect(readExposure("")).toBeUndefined();
    expect(readExposure(exposureParams(1).toUpperCase())).toBeUndefined();
    expect(readExposure(exposureParams(1).slice(2))).toBeUndefined();
    expect(readCrop(`${cropParams({ left: 0, top: 0, right: 1, bottom: 1 })}00`)).toBeUndefined();
    expect(readCrop("zz".repeat(24))).toBeUndefined();
  });
});
