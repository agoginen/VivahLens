import { promises as fs } from "node:fs";
import path from "node:path";
import type { AssetRef, ImportResult } from "./editorAdapter.js";

/** For adapters that need no import step: tells the files that can be read from those that cannot, with a reason for each, before anything is written for them. */
export async function checkReadable(assets: readonly AssetRef[]): Promise<ImportResult> {
  const result: ImportResult = { imported: [], skipped: [] };
  for (const asset of assets) {
    const readable = await fs.access(asset.path, fs.constants.R_OK).then(() => true, () => false);
    if (readable) result.imported.push(asset.id);
    else result.skipped.push({ assetId: asset.id, reason: `${path.basename(asset.path)} does not exist or cannot be read` });
  }
  return result;
}
