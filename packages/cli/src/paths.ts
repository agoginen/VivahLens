import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where VivahLens keeps its data (jobs database, backups, licence, Lightroom handshake). `VIVAH_HOME` moves it, for portable installs and for tests. */
export const dataDir = (env: Record<string, string | undefined>): string => env.VIVAH_HOME ?? path.join(os.homedir(), ".vivahlens");

/** True when both paths are the same folder however they are spelled: relative or absolute, symlinked, or in a different case on Windows and macOS. */
export async function sameDirectory(a: string, b: string): Promise<boolean> {
  const real = async (p: string) => {
    try {
      return await fs.realpath(p);
    } catch {
      return path.resolve(p); // does not exist yet: compare as written
    }
  };
  const [x, y] = await Promise.all([real(a), real(b)]);
  return process.platform === "win32" || process.platform === "darwin" ? x.toLowerCase() === y.toLowerCase() : x === y;
}
