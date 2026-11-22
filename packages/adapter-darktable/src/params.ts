/**
 * Parameter blocks for the darktable modules this adapter writes. darktable stores a module's settings as the raw bytes
 * of a C struct (little endian), tagged with the module's version, and reads them back the same way (docs/research/
 * darktable-integration-verification.md §4c, read from release-5.6.2's source: `exposure.c:47,66-75`, `crop.c:44,61-69`).
 * A struct of the wrong size or version is ignored or dropped by darktable, so these layouts are pinned here and
 * checked by the adapter against the installed darktable's version before anything is written.
 */

/** `exposure`: `{ int mode; float black, exposure, deflicker_percentile, deflicker_target_level; int compensate_exposure_bias, compensate_hilite_pres }`, 28 bytes. */
export const EXPOSURE = { operation: "exposure", modversion: 7, bytes: 28 } as const;
/** `crop`: `{ float cx, cy, cw, ch; int ratio_n, ratio_d }`, 24 bytes. cw and ch are the right and bottom edges, not sizes. */
export const CROP = { operation: "crop", modversion: 3, bytes: 24 } as const;

/**
 * darktable's scene-referred workflow raises exposure by this much on a raw file before anything else, and an `exposure`
 * entry in a sidecar replaces that setting instead of adding to it (`exposure.c:350-361`). A recipe's exposure is relative
 * to "no change", so this is added to it to keep a recipe of 0 looking the way darktable shows the file by default.
 * UNVERIFIED on a real install: a person whose darktable uses another workflow sees a constant brightness offset.
 */
export const DEFAULT_EXPOSURE_EV = 0.7;

/** darktable's `black` default for raw files in the exposure module. */
const DEFAULT_BLACK = -0.000244140625;

type Field = { f: number } | { i: number };

function pack(fields: readonly Field[]): string {
  const buffer = Buffer.alloc(fields.length * 4);
  fields.forEach((field, index) => ("f" in field ? buffer.writeFloatLE(field.f, index * 4) : buffer.writeInt32LE(field.i, index * 4)));
  // darktable rejects uppercase hex.
  return buffer.toString("hex");
}

/** An `exposure` entry setting manual exposure to `exposureEv` with the module's defaults for everything else. */
export function exposureParams(exposureEv: number): string {
  return pack([{ i: 0 }, { f: DEFAULT_BLACK }, { f: exposureEv }, { f: 50 }, { f: -4 }, { i: 1 }, { i: 1 }]);
}

/** The part of the image to keep, as fractions of its width and height measured from the top left. */
export interface CropRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A `crop` entry for a free (unconstrained) rectangle. */
export function cropParams(rect: CropRect): string {
  return pack([{ f: rect.left }, { f: rect.top }, { f: rect.right }, { f: rect.bottom }, { i: 0 }, { i: 0 }]);
}

const floats = (hex: string, count: number): number[] => {
  const buffer = Buffer.from(hex, "hex");
  return Array.from({ length: count }, (_, i) => buffer.readFloatLE(i * 4));
};

/** Reads an `exposure` entry back (for tests and for telling a repeat from a change). */
export function readExposure(hex: string): { exposure: number } | undefined {
  if (!/^[0-9a-f]+$/.test(hex) || hex.length !== EXPOSURE.bytes * 2) return undefined;
  return { exposure: floats(hex, 7)[2]! };
}

export function readCrop(hex: string): CropRect | undefined {
  if (!/^[0-9a-f]+$/.test(hex) || hex.length !== CROP.bytes * 2) return undefined;
  const [left, top, right, bottom] = floats(hex, 4) as [number, number, number, number];
  return { left, top, right, bottom };
}
