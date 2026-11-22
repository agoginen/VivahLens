export interface GrayImage {
  width: number;
  height: number;
  /** 8-bit luminance, row-major, width * height bytes. */
  data: Uint8Array;
}

/** Variance of the 4-neighbour Laplacian: low values mean a blurry frame. */
export function laplacianVariance(img: GrayImage): number {
  const { width: w, height: h, data } = img;
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * data[i]! - data[i - 1]! - data[i + 1]! - data[i - w]! - data[i + w]!;
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** The share of pixels that are blown out (250 or more) or crushed (5 or less), where an edit cannot bring the detail back. */
export function clippedShare(img: GrayImage): number {
  let clipped = 0;
  for (const v of img.data) if (v >= 250 || v <= 5) clipped++;
  return img.data.length ? clipped / img.data.length : 0;
}

/** 64-bit difference hash: robust to resizing and small exposure changes. */
export function differenceHash(img: GrayImage): bigint {
  const { width: w, height: h, data } = img;
  const sample = (col: number, row: number): number => {
    const x0 = Math.floor((col * w) / 9);
    const x1 = Math.max(x0 + 1, Math.floor(((col + 1) * w) / 9));
    const y0 = Math.floor((row * h) / 8);
    const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * h) / 8));
    let total = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        total += data[y * w + x] ?? 0;
        count++;
      }
    }
    return total / count;
  };
  let hash = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      hash = (hash << 1n) | (sample(col, row) > sample(col + 1, row) ? 1n : 0n);
    }
  }
  return hash;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}
