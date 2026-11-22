/** Pixel size of an image from its encoded header, without decoding it. Only JPEG and PNG, the formats previews are sent in. */
export function imageDimensions(data: Buffer): { width: number; height: number } | undefined {
  // PNG: 8-byte signature, then the IHDR chunk with width and height as big-endian 32-bit integers.
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 && data.toString("latin1", 12, 16) === "IHDR") {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 4 <= data.length) {
    if (data[i] !== 0xff) return undefined;
    const marker = data[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // markers without a length
      continue;
    }
    const length = data.readUInt16BE(i + 2);
    // Start-of-frame markers (all but DHT, JPG, DAC) carry the height and width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > data.length) return undefined;
      return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
    }
    if (marker === 0xda) return undefined; // image data begins without a frame header
    i += 2 + length;
  }
  return undefined;
}

/** Size and longest edge of a base64 image. Only the start is decoded, because the header says all that is needed. */
export function describeBase64Image(dataBase64: string): { bytes: number; maxEdgePx?: number } {
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((dataBase64.length * 3) / 4) - padding;
  for (const prefixChars of dataBase64.length > 64 * 1024 ? [64 * 1024, dataBase64.length] : [dataBase64.length]) {
    const size = imageDimensions(Buffer.from(dataBase64.slice(0, prefixChars), "base64"));
    if (size) return { bytes, maxEdgePx: Math.max(size.width, size.height) };
  }
  return { bytes };
}
