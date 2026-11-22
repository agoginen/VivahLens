import type { AssetRef, EditRecipe, Preview } from "@vivahlens/core";
import { loadRgba, type Rgba } from "@vivahlens/ingest";
import { encodeJpeg } from "./adapter.js";
import { renderRecipe } from "./render.js";

export interface PreviewRendererOptions {
  /** Long edge of the pictures that are drawn; smaller is faster. */
  maxEdge?: number;
  quality?: number;
  /** How many decoded pictures to keep, so moving a slider does not decode the file again. */
  cacheSize?: number;
  /** Replaces how a picture is read (tests). */
  load?(asset: AssetRef): Promise<Rgba>;
}

/** Draws recipes onto pictures as JPEG previews, decoding each picture once while it stays in the cache. */
export function createPreviewRenderer(opts: PreviewRendererOptions = {}): (asset: AssetRef, recipe: EditRecipe) => Promise<Preview> {
  const maxEdge = opts.maxEdge ?? 1024;
  const limit = opts.cacheSize ?? 6;
  const load = opts.load ?? ((asset: AssetRef) => loadRgba(asset, { maxEdge }));
  const sources = new Map<string, Promise<Rgba>>();

  return async (asset, recipe) => {
    let source = sources.get(asset.id);
    if (source) {
      // Most recently used goes last, so the oldest is what the limit drops.
      sources.delete(asset.id);
    } else {
      source = load(asset);
      source.catch(() => sources.delete(asset.id));
    }
    sources.set(asset.id, source);
    while (sources.size > limit) sources.delete(sources.keys().next().value!);
    const picture = await source;
    return { mediaType: "image/jpeg", dataBase64: encodeJpeg(renderRecipe(picture, recipe), opts.quality ?? 82).toString("base64") };
  };
}
