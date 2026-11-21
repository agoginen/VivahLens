import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

const CHUNK = 1024 * 1024;

/**
 * Fast content fingerprint for large RAW files: SHA-256 over the size plus the first, middle and last MiB.
 * Collisions between different photos are practically impossible; it exists to spot the same file copied
 * or re-imported, not to prove integrity.
 */
export async function fingerprintFile(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const hash = createHash("sha256").update(String(size));
    const offsets = size <= CHUNK * 3 ? [0] : [0, Math.floor(size / 2) - CHUNK / 2, size - CHUNK];
    const length = size <= CHUNK * 3 ? size : CHUNK;
    const buf = Buffer.alloc(length);
    for (const offset of offsets) {
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      hash.update(buf.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
