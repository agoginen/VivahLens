import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";

export interface ZipResult {
  /** Archives written, in order. One archive is named `<name>.zip`; several are `<name>-part1.zip`, `-part2.zip`, ... */
  archives: string[];
  entries: number;
}

/** Without ZIP64 an archive can neither exceed 4 GiB nor hold more than 65 535 entries. */
const HARD_MAX_BYTES = 0xffffffff - 65_536;
const MAX_ENTRIES = 65_535;
const DEFAULT_PART_BYTES = 2 * 1024 ** 3;

const LOCAL_HEADER = 30;
const CENTRAL_ENTRY = 46;
const END_RECORD = 22;

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Packs files (by name, flat) into stored, i.e. uncompressed, ZIP archives: finished JPEGs do not compress, so this
 * is fast and needs no ZIP library. Large sets are split into parts of at most `maxPartBytes` (default 2 GiB) so
 * every archive stays within the classic ZIP limits and opens in any tool.
 */
export async function writeZip(opts: { files: readonly string[]; outBase: string; maxPartBytes?: number }): Promise<ZipResult> {
  const maxPart = Math.min(opts.maxPartBytes ?? DEFAULT_PART_BYTES, HARD_MAX_BYTES);
  const files = [...opts.files].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  const sized = await Promise.all(files.map(async (file) => ({ file, name: Buffer.from(path.basename(file), "utf8"), stat: await fs.stat(file) })));

  const parts: (typeof sized)[] = [];
  let current: typeof sized = [];
  let bytes = END_RECORD;
  for (const f of sized) {
    const cost = LOCAL_HEADER + CENTRAL_ENTRY + 2 * f.name.length + f.stat.size;
    if (END_RECORD + cost > HARD_MAX_BYTES) throw new Error(`${path.basename(f.file)} is too large for a ZIP archive (limit 4 GiB)`);
    if (current.length && (bytes + cost > maxPart || current.length >= MAX_ENTRIES)) {
      parts.push(current);
      current = [];
      bytes = END_RECORD;
    }
    current.push(f);
    bytes += cost;
  }
  if (current.length) parts.push(current);
  if (!parts.length) throw new Error("Nothing to pack into a ZIP archive");

  const written: string[] = [];
  const temps: string[] = [];
  try {
    for (const [i, part] of parts.entries()) {
      const target = parts.length === 1 ? `${opts.outBase}.zip` : `${opts.outBase}-part${i + 1}.zip`;
      const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
      temps.push(tmp);
      const handle = await fs.open(tmp, "w");
      try {
        const central: Buffer[] = [];
        let offset = 0;
        for (const { file, name, stat } of part) {
          const data = await fs.readFile(file);
          const { time, date } = dosDateTime(stat.mtime);
          const crc = crc32(data);

          const local = Buffer.alloc(LOCAL_HEADER);
          local.writeUInt32LE(0x04034b50, 0);
          local.writeUInt16LE(20, 4); // version needed
          local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
          local.writeUInt16LE(0, 8); // method: stored
          local.writeUInt16LE(time, 10);
          local.writeUInt16LE(date, 12);
          local.writeUInt32LE(crc, 14);
          local.writeUInt32LE(data.length, 18);
          local.writeUInt32LE(data.length, 22);
          local.writeUInt16LE(name.length, 26);
          await handle.write(local);
          await handle.write(name);
          await handle.write(data);

          const entry = Buffer.alloc(CENTRAL_ENTRY);
          entry.writeUInt32LE(0x02014b50, 0);
          entry.writeUInt16LE(20, 4); // version made by
          entry.writeUInt16LE(20, 6); // version needed
          entry.writeUInt16LE(0x0800, 8);
          entry.writeUInt16LE(0, 10);
          entry.writeUInt16LE(time, 12);
          entry.writeUInt16LE(date, 14);
          entry.writeUInt32LE(crc, 16);
          entry.writeUInt32LE(data.length, 20);
          entry.writeUInt32LE(data.length, 24);
          entry.writeUInt16LE(name.length, 28);
          entry.writeUInt32LE(offset, 42);
          central.push(entry, name);
          offset += LOCAL_HEADER + name.length + data.length;
        }
        const directory = Buffer.concat(central);
        const end = Buffer.alloc(END_RECORD);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(part.length, 8);
        end.writeUInt16LE(part.length, 10);
        end.writeUInt32LE(directory.length, 12);
        end.writeUInt32LE(offset, 16);
        await handle.write(directory);
        await handle.write(end);
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, target);
      written.push(target);
    }
  } catch (err) {
    await Promise.all([...temps, ...written].map((f) => fs.rm(f, { force: true })));
    throw err;
  }
  return { archives: written, entries: sized.length };
}
