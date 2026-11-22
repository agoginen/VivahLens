import path from "node:path";
import type { AssetRef } from "../adapters/editorAdapter.js";

const stemOf = (asset: AssetRef) => path.parse(asset.path).name;

/**
 * The file name (without extension) for each asset's export, keyed by asset id. A RAW and its camera JPEG share a
 * name (IMG_001.CR3, IMG_001.JPG) and would otherwise write the same output file, the later overwriting the earlier.
 * The first of each such group (by file name) keeps the plain name; the others get their own extension added
 * (IMG_001-jpg), and a counter if even that is taken. Names are compared ignoring case, as Windows and macOS do.
 *
 * Decided over every asset of the job, not only the ones being exported now, so a photo's name does not depend on
 * what else is exported alongside it, or when.
 */
export function exportNames(assets: readonly AssetRef[]): Map<string, string> {
  const groups = new Map<string, AssetRef[]>();
  for (const asset of assets) {
    const key = stemOf(asset).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), asset]);
  }
  const taken = new Set(groups.keys());
  const names = new Map<string, string>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => path.basename(a.path).localeCompare(path.basename(b.path)) || a.id.localeCompare(b.id));
    names.set(ordered[0]!.id, stemOf(ordered[0]!));
    for (const asset of ordered.slice(1)) {
      const ext = path.extname(asset.path).slice(1).toLowerCase() || "copy";
      let candidate = `${stemOf(asset)}-${ext}`;
      for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stemOf(asset)}-${ext}-${n}`;
      taken.add(candidate.toLowerCase());
      names.set(asset.id, candidate);
    }
  }
  return names;
}
