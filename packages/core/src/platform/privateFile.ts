import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VivahError } from "../errors.js";
import { nodeRunner, type Runner } from "./runner.js";

/**
 * Files that hold a secret (a refresh token, a port and token for a plugin) must be readable by the user and nobody else.
 * POSIX does that with the mode a file is created with. On Windows a file's `mode` is ignored: the file gets the folder's
 * access list, so it is restricted with icacls (to the user's numeric SID, which works for every kind of account) and the
 * result is read back before the secret is written.
 */

const system32 = () => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");

let cachedSid: string | undefined;

/** The current Windows user's SID, from `whoami /user`; names (`DOMAIN\user`) are not reliable for work and school accounts. */
export async function currentUserSid(run: Runner = nodeRunner): Promise<string> {
  if (cachedSid) return cachedSid;
  const res = await run(path.join(system32(), "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { timeoutMs: 15_000 });
  const match = /^"[^"]+","(S-1-\d+(?:-\d+)+)"\s*$/m.exec(res.stdout.toString("utf8"));
  if (res.code !== 0 || !match) throw new VivahError("FILE_PROTECTION_FAILED", "Could not find out which Windows account this is, so a private file cannot be protected.");
  cachedSid = match[1]!;
  return cachedSid;
}

/** Forgets the cached SID (tests). */
export const forgetUserSid = (): void => {
  cachedSid = undefined;
};

/** Makes a file, or with `inherit` a folder and what is created in it later, accessible to the current user only. */
export async function restrictToCurrentUser(target: string, opts: { run?: Runner; folder?: boolean } = {}): Promise<void> {
  const run = opts.run ?? nodeRunner;
  const sid = await currentUserSid(run);
  const grant = opts.folder ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  const res = await run(path.join(system32(), "icacls.exe"), [target, "/inheritance:r", "/grant:r", grant, "/Q"], { timeoutMs: 20_000 });
  if (res.code !== 0) throw new VivahError("FILE_PROTECTION_FAILED", `Could not restrict ${path.basename(target)} to your account: ${res.stderr.slice(0, 200) || res.startError || `icacls exited ${res.code}`}`);
}

/** The allowed-access entries of an access list in SDDL form, e.g. `D:PAI(A;;FA;;;S-1-5-21-1)`. */
export function parseAces(sddl: string): { type: string; flags: string; rights: string; trustee: string }[] {
  const start = sddl.indexOf("D:");
  const afterD = start >= 0 ? sddl.slice(start + 2) : sddl;
  const sacl = afterD.search(/\)S:/);
  const dacl = sacl >= 0 ? afterD.slice(0, sacl + 1) : afterD;
  return [...dacl.matchAll(/\(([A-Z]+);([A-Z]*);([A-Za-z0-9]*);[^;]*;[^;]*;([^)]+)\)/g)].map((m) => ({ type: m[1]!, flags: m[2]!, rights: m[3]!, trustee: m[4]! }));
}

/** The accounts SDDL writes as a short name rather than a SID, for when the program is running as one of them. */
const ALIAS_SIDS: Readonly<Record<string, string>> = { SY: "S-1-5-18", LS: "S-1-5-19", NS: "S-1-5-20" };

/** Whether an access-list trustee (a SID, or one of SDDL's short names) is the account with this SID. */
function isAccount(trustee: string, sid: string): boolean {
  if (trustee === sid) return true;
  if (Object.hasOwn(ALIAS_SIDS, trustee)) return ALIAS_SIDS[trustee] === sid;
  // The built-in local Administrator and Guest are written LA and LG, not as the machine's SID plus 500 or 501. A computer
  // whose user is that Administrator (a build server, say) would otherwise never see its own locked-down files as private.
  if (trustee === "LA") return /^S-1-5-21(?:-\d+){3}-500$/.test(sid);
  if (trustee === "LG") return /^S-1-5-21(?:-\d+){3}-501$/.test(sid);
  return false;
}

/** True when the access list has exactly allow entries for this account and nothing else (no SYSTEM, administrators or groups). */
export function isOwnerOnly(sddl: string, sid: string): boolean {
  const aces = parseAces(sddl);
  return aces.length > 0 && aces.every((a) => a.type === "A" && isAccount(a.trustee, sid));
}

/** The accounts in an access list, for saying what was found: a SID loses the part that identifies the computer or domain. */
function describeAccess(sddl: string): string {
  const shorten = (trustee: string) => {
    const parts = trustee.split("-");
    return parts.length > 5 ? `${parts.slice(0, 4).join("-")}-…-${parts.at(-1)}` : trustee;
  };
  const found = parseAces(sddl).map((a) => `${a.type === "A" ? "" : "a deny for "}${shorten(a.trustee)}`);
  return found.length > 0 ? found.join(", ") : "no entries";
}

/** Reads a file's access list with `icacls /save`: whether it grants this user and no one else, and who it does grant. */
async function inspectAccess(target: string, run: Runner): Promise<{ private: boolean; found: string }> {
  const sid = await currentUserSid(run);
  const scratch = path.join(os.tmpdir(), `vivah-acl-${randomBytes(6).toString("hex")}.txt`);
  try {
    const res = await run(path.join(system32(), "icacls.exe"), [target, "/save", scratch, "/Q"], { timeoutMs: 20_000 });
    if (res.code !== 0) return { private: false, found: `icacls exited ${res.code}` };
    const saved = (await fs.readFile(scratch)).toString("utf16le").replace(/^\uFEFF/, "");
    const sddl = saved.split(/\r?\n/).find((line) => line.startsWith("D:"));
    if (sddl === undefined) return { private: false, found: "no access list" };
    return { private: isOwnerOnly(sddl, sid), found: describeAccess(sddl) };
  } finally {
    await fs.rm(scratch, { force: true }).catch(() => undefined);
  }
}

/** Checks that a file's or folder's access list grants this user and no one else. */
export async function isCurrentUserOnly(target: string, run: Runner = nodeRunner): Promise<boolean> {
  return (await inspectAccess(target, run)).private;
}

export interface PrivateIo {
  run?: Runner;
  /** Overrides process.platform (tests). */
  platform?: NodeJS.Platform;
}

/**
 * Writes a file only its owner can read, and replaces any earlier one atomically. On Windows the secret is written only
 * after the file's access list has been restricted and checked; on POSIX the file is created with mode 0600 in one step.
 */
export async function writePrivateFile(file: string, data: string | Uint8Array, io: PrivateIo = {}): Promise<void> {
  const platform = io.platform ?? process.platform;
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await fs.open(temp, "wx", platform === "win32" ? undefined : 0o600);
  try {
    if (platform === "win32") {
      await restrictToCurrentUser(temp, io.run ? { run: io.run } : {});
      const access = await inspectAccess(temp, io.run ?? nodeRunner);
      if (!access.private) throw new VivahError("FILE_PROTECTION_FAILED", `The access list of ${path.basename(file)} could not be confirmed as private (found: ${access.found}), so nothing was written to it.`);
    } else if (((await handle.stat()).mode & 0o077) !== 0) {
      throw new VivahError("FILE_PROTECTION_FAILED", `${path.basename(file)} was created readable by others, so nothing was written to it.`);
    }
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
  await handle.close();
  try {
    await fs.rename(temp, file);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Creates a folder for secrets that only this user can use. A folder that already exists is checked rather than changed:
 * one that belongs to someone else, or that others can open, is refused (this is also what stops a pre-made folder from
 * being used to read the secrets later).
 */
export async function ensurePrivateDir(dir: string, io: PrivateIo = {}): Promise<void> {
  const platform = io.platform ?? process.platform;
  const existed = await fs.stat(dir).then(() => true, () => false);
  await fs.mkdir(dir, { recursive: true, ...(platform !== "win32" && { mode: 0o700 }) });
  if (platform === "win32") {
    if (!existed) await restrictToCurrentUser(dir, { folder: true, ...(io.run && { run: io.run }) });
    const access = await inspectAccess(dir, io.run ?? nodeRunner);
    if (!access.private) throw new VivahError("FILE_PROTECTION_FAILED", `${dir} can be opened by other accounts (found: ${access.found}), so it will not be used for secrets.`);
    return;
  }
  const info = await fs.lstat(dir);
  if (!info.isDirectory() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) {
    throw new VivahError("FILE_PROTECTION_FAILED", `${dir} is not a private folder owned by you, so it will not be used for secrets.`);
  }
}
