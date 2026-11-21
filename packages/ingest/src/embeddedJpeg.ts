/**
 * Finds the largest complete JPEG embedded in a RAW container (CR2/CR3/NEF/ARW/RAF/ORF/DNG/RW2 all carry
 * one), or returns the whole buffer when the file is itself a JPEG. Works by walking JPEG marker segments,
 * so nested EXIF thumbnails are skipped rather than mistaken for the preview.
 */
export function extractEmbeddedJpeg(file: Uint8Array): Uint8Array | undefined {
  let best: { start: number; end: number } | undefined;
  let i = 0;
  while (i < file.length - 3) {
    if (file[i] === 0xff && file[i + 1] === 0xd8 && file[i + 2] === 0xff) {
      const end = jpegEnd(file, i);
      if (end !== undefined) {
        if (!best || end - i > best.end - best.start) best = { start: i, end };
        i = end;
        continue;
      }
    }
    i++;
  }
  return best && file.subarray(best.start, best.end);
}

/** Offset one past the EOI of the JPEG starting at `start`, or undefined if it is not a well-formed JPEG. */
function jpegEnd(b: Uint8Array, start: number): number | undefined {
  let i = start + 2;
  let sawFrame = false;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd9) return sawFrame ? i + 2 : undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (i + 3 >= b.length) return undefined;
    const length = (b[i + 2]! << 8) | b[i + 3]!;
    if (length < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) sawFrame = true;
    i += 2 + length;
    if (marker === 0xda) {
      // Entropy-coded data: skip to the next real marker (not a stuffed 0xFF00 or a restart marker).
      while (i + 1 < b.length && !(b[i] === 0xff && b[i + 1] !== 0x00 && !(b[i + 1]! >= 0xd0 && b[i + 1]! <= 0xd7))) i++;
    }
  }
  return undefined;
}
