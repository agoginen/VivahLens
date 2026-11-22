import { promises as fs } from "node:fs";
import path from "node:path";
import { ensurePrivateDir } from "../platform/privateFile.js";
import type { LogRecord } from "./logger.js";

export interface LogFileOptions {
  dir: string;
  /** A file is closed and a new one started when it would pass this size (default 2 MB). */
  maxBytes?: number;
  /** How many closed files to keep besides the current one (default 4). */
  keep?: number;
  /** Base name (default "vivah"): files are `vivah.jsonl`, `vivah.1.jsonl`, … (1 is the newest closed one). */
  name?: string;
}

export interface LogFile {
  /** Queues one line. Never throws; a failed write is counted in `failedWrites`. */
  write(line: string): void;
  /** Resolves when everything queued so far has been written. */
  flush(): Promise<void>;
  readonly file: string;
  readonly failedWrites: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_KEEP = 4;

const fileOf = (dir: string, name: string, index: number) => path.join(dir, index === 0 ? `${name}.jsonl` : `${name}.${index}.jsonl`);

/**
 * A size-limited, rotating JSON-lines file in a folder only the user can open. Logs hold metadata, but file names and
 * job ids are the photographer's business, and old logs must not pile up without limit.
 */
export async function openLogFile(opts: LogFileOptions): Promise<LogFile> {
  const { dir } = opts;
  const name = opts.name ?? "vivah";
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = Math.max(0, opts.keep ?? DEFAULT_KEEP);
  await ensurePrivateDir(dir);
  const file = fileOf(dir, name, 0);
  let size = await fs.stat(file).then((s) => s.size, () => 0);
  let chain: Promise<void> = Promise.resolve();
  let failed = 0;

  async function rotate(): Promise<void> {
    // The file at index `keep` falls off the end; with keep = 0 that is the current file itself.
    await fs.rm(fileOf(dir, name, keep), { force: true });
    for (let i = keep - 1; i >= 0; i--) {
      await fs.rename(fileOf(dir, name, i), fileOf(dir, name, i + 1)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    }
    size = 0;
  }

  const append = async (line: string) => {
    const data = `${line}\n`;
    const bytes = Buffer.byteLength(data);
    if (size > 0 && size + bytes > maxBytes) await rotate();
    await fs.appendFile(file, data, { mode: 0o600 });
    size += bytes;
  };

  return {
    file,
    get failedWrites() {
      return failed;
    },
    write(line) {
      chain = chain.then(() => append(line)).catch(() => void failed++);
    },
    flush: () => chain,
  };
}

/** The newest records across the current and closed log files, oldest first. Lines that are not JSON are skipped. */
export async function readRecentLogs(dir: string, opts: { name?: string; maxRecords?: number } = {}): Promise<LogRecord[]> {
  const name = opts.name ?? "vivah";
  const wanted = opts.maxRecords ?? 500;
  const out: LogRecord[] = [];
  for (let index = 0; out.length < wanted; index++) {
    const text = await fs.readFile(fileOf(dir, name, index), "utf8").catch(() => undefined);
    if (text === undefined) {
      // Closed files are numbered without gaps; a missing current file just means nothing has been logged yet.
      if (index === 0) continue;
      break;
    }
    const records: LogRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as LogRecord);
      } catch {
        // A partly written last line after a crash.
      }
    }
    out.unshift(...records.slice(-(wanted - out.length)));
  }
  return out;
}
