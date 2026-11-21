export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/** EXIF orientation (1–8) from a JPEG's APP1 segment; 1 when absent or unreadable. */
export function readOrientation(jpeg: Uint8Array): number {
  let i = 2;
  while (i + 4 < jpeg.length && jpeg[i] === 0xff) {
    const marker = jpeg[i + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const length = (jpeg[i + 2]! << 8) | jpeg[i + 3]!;
    const body = i + 4;
    if (marker === 0xe1 && length >= 14 && String.fromCharCode(...jpeg.subarray(body, body + 4)) === "Exif") {
      return orientationFromTiff(jpeg, body + 6, Math.min(jpeg.length, i + 2 + length));
    }
    i += 2 + length;
  }
  return 1;
}

function orientationFromTiff(b: Uint8Array, tiff: number, end: number): number {
  if (tiff + 8 > end) return 1;
  const little = b[tiff] === 0x49;
  const u16 = (o: number) => (little ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!);
  const u32 = (o: number) => (little ? u16(o) + u16(o + 2) * 0x10000 : u16(o) * 0x10000 + u16(o + 2));
  if (u16(tiff + 2) !== 42) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let n = 0; n < count; n++) {
    const entry = ifd + 2 + n * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** Rotates/mirrors pixels so the image is upright. Orientation 1 returns the input unchanged. */
export function applyOrientation(img: Rgba, orientation: number): Rgba {
  if (orientation <= 1 || orientation > 8) return img;
  const swap = orientation >= 5;
  const w = swap ? img.height : img.width;
  const h = swap ? img.width : img.height;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      // Destination coordinates for each EXIF orientation.
      let dx: number, dy: number;
      switch (orientation) {
        case 2: dx = img.width - 1 - x; dy = y; break;
        case 3: dx = img.width - 1 - x; dy = img.height - 1 - y; break;
        case 4: dx = x; dy = img.height - 1 - y; break;
        case 5: dx = y; dy = x; break;
        case 6: dx = img.height - 1 - y; dy = x; break;
        case 7: dx = img.height - 1 - y; dy = img.width - 1 - x; break;
        default: dx = y; dy = img.width - 1 - x; break;
      }
      const s = (y * img.width + x) * 4;
      const d = (dy * w + dx) * 4;
      out[d] = img.data[s]!;
      out[d + 1] = img.data[s + 1]!;
      out[d + 2] = img.data[s + 2]!;
      out[d + 3] = img.data[s + 3]!;
    }
  }
  return { width: w, height: h, data: out };
}
