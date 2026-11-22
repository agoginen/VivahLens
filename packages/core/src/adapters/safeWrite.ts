import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { VivahError } from "../errors.js";
import type { AdapterContext } from "./editorAdapter.js";

/** What a write replaced, in the form the pipeline keeps for undo (`ApplyResult.replaced`). */
export interface ReplacedFile {
  target: string;
  /** A copy of what was at `target`; absent when the file was new or no backup folder was given. */
  backup?: string;
  /** SHA-256 of what was written, so an undo can tell whether the file was changed again afterwards. */
  writtenSha256: string;
}

export interface WriteReplacingOptions {
  /** Where copies of replaced files go. Without it nothing is kept, and the write reports that it cannot be undone. */
  backupDir?: string;
}

export const sha256Hex = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** Another program may hold the file open for a moment (an editor reading its sidecar): Windows then refuses the replace, so try again briefly. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 6 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw err;
      await new Promise((resolve) => setTimeout(resolve, 40 * 2 ** attempt));
    }
  }
}

function writeFailure(target: string, err: unknown): VivahError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOSPC") return new VivahError("DISK_FULL", `The disk is full: ${path.basename(target)} was not written and the original is untouched`);
  return new VivahError("ADAPTER_APPLY_FAILED", `Could not write ${path.basename(target)}: ${err instanceof Error ? err.message : String(err)}`);
}

/** The result of one replacing write. */
export interface WriteOutcome {
  /** Present when the write can be undone: the file is new (undo deletes it) or a copy of the old one was kept. */
  replaced?: ReplacedFile;
  /** Present when it cannot be undone: the file existed and no backup folder was given. Never record such a write for undo. */
  warning?: string;
}

/**
 * Replaces a file so that a reader never sees half of it and the original survives any failure: the new content goes to
 * a temporary file in the same folder, is flushed, and moved over the target; the target is then read back and compared.
 * A copy of what was there is kept first when a backup folder is given (plan §7g).
 */
export async function writeReplacing(target: string, content: string | Buffer | ((before: Buffer | undefined) => string | Buffer), opts: WriteReplacingOptions = {}): Promise<WriteOutcome> {
  let before: Buffer | undefined;
  let mode: number | undefined;
  try {
    before = await fs.readFile(target);
    mode = (await fs.stat(target)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw writeFailure(target, err);
  }
  const produced = typeof content === "function" ? content(before) : content;
  const data = typeof produced === "string" ? Buffer.from(produced, "utf8") : produced;

  let backup: string | undefined;
  if (before && opts.backupDir) {
    try {
      await fs.mkdir(opts.backupDir, { recursive: true });
      const key = sha256Hex(Buffer.from(path.resolve(target))).slice(0, 10);
      backup = path.join(opts.backupDir, `${key}-${randomBytes(3).toString("hex")}-${path.basename(target)}`);
      await fs.writeFile(backup, before, { flag: "wx" });
    } catch (err) {
      throw writeFailure(backup ?? target, err);
    }
  }

  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await fs.open(tmp, "wx", mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw writeFailure(target, err);
  }

  const after = await fs.readFile(target).catch(() => undefined);
  if (!after || !after.equals(data)) {
    if (before) await fs.writeFile(target, before).catch(() => undefined);
    throw new VivahError("ADAPTER_APPLY_FAILED", `${path.basename(target)} did not read back as it was written; the original was put back`);
  }
  if (before && !backup) {
    return { warning: `${path.basename(target)} already existed and no backup folder is configured, so this change cannot be undone` };
  }
  return { replaced: { target, ...(backup && { backup }), writtenSha256: sha256Hex(data) } };
}

/** Stops an adapter that is about to start work for a job that has been cancelled. */
export function throwIfCancelled(ctx?: AdapterContext): void {
  if (ctx?.signal?.aborted) throw new VivahError("ADAPTER_CANCELLED", "Cancelled before the editor was touched");
}

/** The backup folder for one job: copies for different jobs never mix, and a finished job's copies can be deleted together. */
export const jobBackupDir = (root: string | undefined, ctx?: AdapterContext): string | undefined => (root ? path.join(root, ctx?.jobId ?? "adhoc") : undefined);
