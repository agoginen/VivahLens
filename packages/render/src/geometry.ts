import type { Rgba } from "./color.js";

export interface CropSpec {
  aspectRatio?: string | undefined;
  /** Fractions (0 to 1) of the source, from its top-left corner. */
  x?: number | undefined;
  y?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  /** Degrees; positive turns the picture clockwise. */
  rotationDeg?: number | undefined;
}

/** Where the result comes from in the source: a rectangle (centre and size, in source pixels), turned by `angle` radians. */
export interface CropGeometry {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
}

/** Width over height for "3:2", "16x9" or "1.5"; "original" keeps the source's own; undefined when it is not a ratio. */
export function parseAspect(text: string, sourceW: number, sourceH: number): number | undefined {
  if (/^(original|as ?shot|orig)$/i.test(text.trim())) return sourceW / sourceH;
  const pair = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i.exec(text.trim());
  if (pair) {
    const a = Number(pair[1]);
    const b = Number(pair[2]);
    return a > 0 && b > 0 ? a / b : undefined;
  }
  const single = Number(text);
  return Number.isFinite(single) && single > 0 ? single : undefined;
}

/**
 * Works out the rectangle a crop asks for. Given edges are honoured as they are. Otherwise the whole frame is used, cut
 * to the requested aspect ratio, and shrunk when the picture is straightened so no empty corner shows: the largest
 * centred rectangle of that aspect that fits inside the turned frame.
 */
export function cropGeometry(sourceW: number, sourceH: number, crop: CropSpec | undefined): CropGeometry | undefined {
  const turn = ((crop?.rotationDeg ?? 0) * Math.PI) / 180;
  const explicit = crop && (crop.x !== undefined || crop.y !== undefined || crop.width !== undefined || crop.height !== undefined);
  const aspect = crop?.aspectRatio ? parseAspect(crop.aspectRatio, sourceW, sourceH) : undefined;
  if (!explicit && aspect === undefined && turn === 0) return undefined;

  if (explicit) {
    const x = Math.min(0.99, Math.max(0, crop.x ?? 0));
    const y = Math.min(0.99, Math.max(0, crop.y ?? 0));
    const width = Math.min(1 - x, Math.max(0.01, crop.width ?? 1 - x));
    const height = Math.min(1 - y, Math.max(0.01, crop.height ?? 1 - y));
    return { cx: (x + width / 2) * sourceW, cy: (y + height / 2) * sourceH, width: width * sourceW, height: height * sourceH, angle: turn };
  }

  const a = aspect ?? sourceW / sourceH;
  const cos = Math.cos(Math.abs(turn));
  const sin = Math.sin(Math.abs(turn));
  const width = Math.min(sourceW / (cos + sin / a), sourceH / (sin + cos / a));
  return { cx: sourceW / 2, cy: sourceH / 2, width, height: width / a, angle: turn };
}

/** Cuts (and turns) the rectangle out of the source with bilinear sampling; pixels beyond the border repeat the edge. */
export function sampleCrop(source: Rgba, geometry: CropGeometry): Rgba {
  const outW = Math.max(1, Math.round(geometry.width));
  const outH = Math.max(1, Math.round(geometry.height));
  const out = new Uint8Array(outW * outH * 4);
  const cos = Math.cos(geometry.angle);
  const sin = Math.sin(geometry.angle);
  const { width: sw, height: sh, data } = source;
  const scaleX = geometry.width / outW;
  const scaleY = geometry.height / outH;
  for (let v = 0; v < outH; v++) {
    const ly = (v + 0.5 - outH / 2) * scaleY;
    for (let u = 0; u < outW; u++) {
      const lx = (u + 0.5 - outW / 2) * scaleX;
      const sx = geometry.cx + lx * cos + ly * sin - 0.5;
      const sy = geometry.cy - lx * sin + ly * cos - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const xa = Math.min(sw - 1, Math.max(0, x0));
      const xb = Math.min(sw - 1, Math.max(0, x0 + 1));
      const ya = Math.min(sh - 1, Math.max(0, y0));
      const yb = Math.min(sh - 1, Math.max(0, y0 + 1));
      const i00 = (ya * sw + xa) * 4;
      const i10 = (ya * sw + xb) * 4;
      const i01 = (yb * sw + xa) * 4;
      const i11 = (yb * sw + xb) * 4;
      const o = (v * outW + u) * 4;
      for (let c = 0; c < 3; c++) {
        const top = data[i00 + c]! * (1 - fx) + data[i10 + c]! * fx;
        const bottom = data[i01 + c]! * (1 - fx) + data[i11 + c]! * fx;
        out[o + c] = top * (1 - fy) + bottom * fy + 0.5;
      }
      out[o + 3] = 255;
    }
  }
  return { width: outW, height: outH, data: out };
}
