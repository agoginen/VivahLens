export interface SceneSignature {
  id: string;
  /** Mean luminance, 0–255. */
  meanLuma: number;
  /** Estimated colour temperature in Kelvin. */
  tempK: number;
}

/**
 * Groups images by lighting so indoor and outdoor frames get separate style variants.
 * Greedy leader clustering: an image joins the nearest cluster within the threshold, else starts one.
 */
export function clusterScenes(
  items: readonly SceneSignature[],
  opts: { lumaThreshold?: number; tempThresholdK?: number } = {},
): string[][] {
  const lumaT = opts.lumaThreshold ?? 40;
  const tempT = opts.tempThresholdK ?? 800;
  const clusters: { leader: SceneSignature; ids: string[] }[] = [];
  for (const item of items) {
    let best: { cluster: (typeof clusters)[number]; dist: number } | undefined;
    for (const cluster of clusters) {
      const dl = Math.abs(item.meanLuma - cluster.leader.meanLuma) / lumaT;
      const dt = Math.abs(item.tempK - cluster.leader.tempK) / tempT;
      if (dl > 1 || dt > 1) continue;
      const dist = Math.hypot(dl, dt);
      if (!best || dist < best.dist) best = { cluster, dist };
    }
    if (best) best.cluster.ids.push(item.id);
    else clusters.push({ leader: item, ids: [item.id] });
  }
  return clusters.map((c) => c.ids);
}
