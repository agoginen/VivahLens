/** One horizontal pass of a box blur with the edge pixel repeated beyond the border. */
function boxRows(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const size = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))]!;
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc / size;
      acc += src[row + Math.min(w - 1, x + r + 1)]! - src[row + Math.max(0, x - r)]!;
    }
  }
}

function boxColumns(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const size = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[Math.min(h - 1, Math.max(0, k)) * w + x]!;
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc / size;
      acc += src[Math.min(h - 1, y + r + 1) * w + x]! - src[Math.max(0, y - r) * w + x]!;
    }
  }
}

/** A box blur of the whole plane; `radius` is rounded to whole pixels (at least 1). */
export function boxBlur(plane: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(plane.length);
  const out = new Float32Array(plane.length);
  boxRows(plane, tmp, w, h, r);
  boxColumns(tmp, out, w, h, r);
  return out;
}

/**
 * Three box passes, which approximate a Gaussian of standard deviation `sigma` (in pixels) closely enough for local
 * contrast, sharpening and noise reduction.
 */
export function gaussianBlur(plane: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  const rows = new Float32Array(plane.length);
  const out = new Float32Array(plane.length);
  boxRows(plane, rows, w, h, r);
  boxColumns(rows, out, w, h, r);
  for (let pass = 1; pass < 3; pass++) {
    boxRows(out, rows, w, h, r);
    boxColumns(rows, out, w, h, r);
  }
  return out;
}
