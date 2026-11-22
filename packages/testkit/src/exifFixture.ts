export interface ExifFixture {
  /** Orientation tag in the first IFD (1 to 8). */
  orientation?: number;
  /** Pixel dimensions in the EXIF IFD. */
  width?: number;
  height?: number;
  littleEndian?: boolean;
}

/**
 * A minimal EXIF block as it sits in a JPEG (the APP1 marker and length included): an orientation tag in the first IFD and
 * the pixel dimensions in the EXIF IFD that the first IFD points to. For tests that carry EXIF through an edit.
 */
export function makeExifSegment(opts: ExifFixture = {}): Uint8Array {
  const little = opts.littleEndian ?? false;
  const tiff = new Uint8Array(68);
  const put = (offset: number, value: number, bytes: 2 | 4) => {
    for (let k = 0; k < bytes; k++) tiff[offset + (little ? k : bytes - 1 - k)] = (value >>> (8 * k)) & 0xff;
  };
  tiff.set([little ? 0x49 : 0x4d, little ? 0x49 : 0x4d], 0);
  put(2, 42, 2);
  put(4, 8, 4);

  // First IFD at 8: orientation (SHORT) and the pointer to the EXIF IFD at 38.
  put(8, 2, 2);
  put(10, 0x0112, 2);
  put(12, 3, 2);
  put(14, 1, 4);
  put(18, opts.orientation ?? 1, 2);
  put(22, 0x8769, 2);
  put(24, 4, 2);
  put(26, 1, 4);
  put(30, 38, 4);
  put(34, 0, 4);

  // EXIF IFD at 38: pixel X and Y dimensions (LONG).
  put(38, 2, 2);
  put(40, 0xa002, 2);
  put(42, 4, 2);
  put(44, 1, 4);
  put(48, opts.width ?? 6000, 4);
  put(52, 0xa003, 2);
  put(54, 4, 2);
  put(56, 1, 4);
  put(60, opts.height ?? 4000, 4);
  put(64, 0, 4);

  const segment = new Uint8Array(4 + 6 + tiff.length);
  segment.set([0xff, 0xe1, 0, 2 + 6 + tiff.length], 0);
  segment.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  segment.set(tiff, 10);
  return segment;
}
