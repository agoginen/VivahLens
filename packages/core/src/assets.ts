import { Buffer } from "node:buffer";

/** The part of `node:sea` this needs. */
export interface SeaModule {
  isSea(): boolean;
  getAsset(key: string): ArrayBuffer;
}

/**
 * A file that ships inside the single-file build, or undefined: when this is not that build, or the build holds no such file.
 * The review page, the Lightroom plugin and the image decoder are files beside the code; in the single executable they are
 * embedded in it, and each place that loads one tries this first and falls back to its file on disk.
 */
export function embeddedAssetFrom(sea: SeaModule | undefined, key: string): Buffer | undefined {
  if (!sea?.isSea()) return undefined;
  try {
    return Buffer.from(sea.getAsset(key));
  } catch {
    return undefined;
  }
}

export function embeddedAsset(key: string): Buffer | undefined {
  // getBuiltinModule is missing on the oldest supported Node 22 releases, and then nothing can be embedded.
  return embeddedAssetFrom(process.getBuiltinModule?.("node:sea") as SeaModule | undefined, key);
}
