import { fingerprintFile, loadAnalysis, type Analysis } from "@vivahlens/ingest";
import type { AssetRef, GrayImage } from "@vivahlens/core";

/**
 * Decodes each photo once for everything that needs pixels before the LLM runs (fingerprint/EXIF, culling image,
 * scene stats). The culling image is released after its single use so a 1,500-photo job does not hold them all in memory.
 */
export class AnalysisCache {
  private entries = new Map<string, { analysis: Promise<Analysis>; grayTaken: boolean }>();

  private entry(asset: AssetRef) {
    let e = this.entries.get(asset.id);
    if (!e) {
      e = { analysis: loadAnalysis(asset), grayTaken: false };
      this.entries.set(asset.id, e);
    }
    return e;
  }

  async gray(asset: AssetRef): Promise<GrayImage> {
    const e = this.entry(asset);
    if (e.grayTaken) {
      this.entries.delete(asset.id);
      return (await this.entry(asset).analysis).gray;
    }
    const { gray, ...rest } = await e.analysis;
    e.grayTaken = true;
    e.analysis = Promise.resolve({ ...rest, gray: { width: 0, height: 0, data: new Uint8Array(0) } });
    return gray;
  }

  async scene(asset: AssetRef): Promise<Analysis["scene"]> {
    return (await this.entry(asset).analysis).scene;
  }

  async describe(asset: AssetRef): Promise<{ fingerprint: string; exif: Record<string, unknown> }> {
    const [fingerprint, analysis] = await Promise.all([fingerprintFile(asset.path), this.entry(asset).analysis]);
    return { fingerprint, exif: { ...analysis.exif } };
  }
}
