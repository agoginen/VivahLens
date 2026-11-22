const u16 = (b: Uint8Array, o: number, little: boolean): number => (little ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!);
const u32 = (b: Uint8Array, o: number, little: boolean): number => (little ? u16(b, o, true) + u16(b, o + 2, true) * 0x10000 : u16(b, o, false) * 0x10000 + u16(b, o + 2, false));

function put(b: Uint8Array, o: number, value: number, bytes: 2 | 4, little: boolean): void {
  for (let k = 0; k < bytes; k++) b[o + (little ? k : bytes - 1 - k)] = (value >>> (8 * k)) & 0xff;
}

/** The EXIF block of a JPEG as one piece (marker and length included), or undefined when it has none. */
export function findExifSegment(jpeg: Uint8Array): Uint8Array | undefined {
  let i = 2;
  while (i + 4 <= jpeg.length && jpeg[i] === 0xff) {
    const marker = jpeg[i + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const length = (jpeg[i + 2]! << 8) | jpeg[i + 3]!;
    if (marker === 0xe1 && length >= 14 && String.fromCharCode(...jpeg.subarray(i + 4, i + 8)) === "Exif") return new Uint8Array(jpeg.subarray(i, Math.min(jpeg.length, i + 2 + length)));
    i += 2 + length;
  }
  return undefined;
}

export interface ExifPatch {
  /** Set the orientation tag (1 = upright), for pictures whose pixels have already been turned. */
  orientation?: number;
  /** Set the pixel dimensions the EXIF block claims, for pictures that were cropped or resized. */
  width?: number;
  height?: number;
}

const ORIENTATION = 0x0112;
const EXIF_IFD = 0x8769;
const PIXEL_X = 0xa002;
const PIXEL_Y = 0xa003;

/** A copy of an EXIF block with some values corrected; tags that are not there are left out rather than added. */
export function patchExif(segment: Uint8Array, patch: ExifPatch): Uint8Array {
  // A real copy even when `segment` is a Node Buffer, whose slice() shares memory with the original.
  const out = new Uint8Array(segment);
  const tiff = 10;
  if (out.length < tiff + 8) return out;
  const little = out[tiff] === 0x49;
  if (u16(out, tiff + 2, little) !== 42) return out;

  const walk = (ifdOffset: number, visit: (tag: number, entry: number) => void): void => {
    const ifd = tiff + ifdOffset;
    if (ifd + 2 > out.length) return;
    const count = u16(out, ifd, little);
    for (let n = 0; n < count; n++) {
      const entry = ifd + 2 + n * 12;
      if (entry + 12 > out.length) return;
      visit(u16(out, entry, little), entry);
    }
  };
  const setNumber = (entry: number, value: number): void => {
    const type = u16(out, entry + 2, little);
    if (type === 3) put(out, entry + 8, value, 2, little);
    else if (type === 4) put(out, entry + 8, value, 4, little);
  };

  walk(u32(out, tiff + 4, little), (tag, entry) => {
    if (tag === ORIENTATION && patch.orientation !== undefined) setNumber(entry, patch.orientation);
    if (tag === EXIF_IFD && (patch.width !== undefined || patch.height !== undefined)) {
      walk(u32(out, entry + 8, little), (inner, innerEntry) => {
        if (inner === PIXEL_X && patch.width !== undefined) setNumber(innerEntry, patch.width);
        if (inner === PIXEL_Y && patch.height !== undefined) setNumber(innerEntry, patch.height);
      });
    }
  });
  return out;
}

/** Puts an EXIF block into a JPEG that has none (the encoder writes none): after the JFIF header when there is one, else first. */
export function insertExif(jpeg: Uint8Array, segment: Uint8Array): Uint8Array {
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4]! << 8) | jpeg[5]!);
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, at), 0);
  out.set(segment, at);
  out.set(jpeg.subarray(at), at + segment.length);
  return out;
}
