import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** A folder the page can show: its name and its full path. */
export interface FolderEntry {
  name: string;
  path: string;
}

export interface FolderListing {
  /** The folder listed, as a full path. */
  path: string;
  /** The folder above it; null at the top of a drive or of the file system. */
  parent: string | null;
  /** The folders inside it, by name. Files are never listed. */
  folders: FolderEntry[];
  /** There are more folders than `folders` holds. */
  truncated: boolean;
}

export interface Place extends FolderEntry {
  kind: "home" | "desktop" | "documents" | "downloads" | "pictures" | "onedrive" | "drive" | "root";
}

export type BrowseCode = "RELATIVE" | "MISSING" | "NOT_A_FOLDER" | "DENIED" | "BAD_NAME" | "EXISTS" | "FAILED";

/** Something the person can fix: a wrong path, a name that cannot be used, a folder they may not open. */
export class BrowseError extends Error {
  constructor(
    readonly code: BrowseCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowseError";
  }
}

const MAX_FOLDERS = 1000;
const MAX_PATH_CHARS = 4096;
const MAX_NAME_CHARS = 100;
const DRIVE_TIMEOUT_MS = 1000;
// Characters Windows refuses in a name (and a control character is refused everywhere), and the device names it reserves.
const INVALID_NAME = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function absolute(input: string): string {
  if (input.length === 0 || input.length > MAX_PATH_CHARS || input.includes("\0") || !path.isAbsolute(input)) {
    throw new BrowseError("RELATIVE", "Enter the full path of a folder, for example C:\\Photos or /home/me/Photos.");
  }
  return path.resolve(input);
}

function failure(err: unknown, dir: string): BrowseError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new BrowseError("MISSING", `${dir} was not found.`);
  if (code === "ENOTDIR") return new BrowseError("NOT_A_FOLDER", `${dir} is not a folder.`);
  if (code === "EACCES" || code === "EPERM") return new BrowseError("DENIED", `${dir} cannot be opened with the permissions this program has.`);
  return new BrowseError("FAILED", err instanceof Error ? err.message : String(err));
}

/** Names that are the system's, not the person's: dot folders, Windows' `$RECYCLE.BIN` and its volume information. */
const hidden = (name: string): boolean => name.startsWith(".") || name.startsWith("$") || name === "System Volume Information";

const byName = (a: FolderEntry, b: FolderEntry): number => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

async function isFolder(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A link counts as a folder when it leads to one that can be opened. Windows keeps old profile links (Application Data,
 * Cookies, Local Settings) that point at folders nobody may open; they are left out rather than offered and refused.
 */
async function isOpenableFolder(file: string): Promise<boolean> {
  try {
    if (!(await fs.stat(file)).isDirectory()) return false;
    await (await fs.opendir(file)).close();
    return true;
  } catch {
    return false;
  }
}

/** Whether `input` names a folder that can be opened, without listing what is in it. Gives its full path. */
export async function checkFolder(input: string): Promise<string> {
  const dir = absolute(input);
  try {
    if (!(await fs.stat(dir)).isDirectory()) throw new BrowseError("NOT_A_FOLDER", `${dir} is not a folder.`);
    await (await fs.opendir(dir)).close();
  } catch (err) {
    throw err instanceof BrowseError ? err : failure(err, dir);
  }
  return dir;
}

/** The folders inside `dir`. Only names are read: nothing about the files in a folder is revealed except what the caller adds. */
export async function listFolder(input: string): Promise<FolderListing> {
  const dir = absolute(input);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw failure(err, dir);
  }
  const folders: FolderEntry[] = [];
  for (const entry of entries) {
    if (hidden(entry.name)) continue;
    const full = path.join(dir, entry.name);
    // A link to a folder (a Windows junction, say) is a folder to the person; one that leads nowhere, or nowhere they may go, is not.
    if (entry.isDirectory() || (entry.isSymbolicLink() && (await isOpenableFolder(full)))) folders.push({ name: entry.name, path: full });
  }
  folders.sort(byName);
  const above = path.dirname(dir);
  return { path: dir, parent: above === dir ? null : above, folders: folders.slice(0, MAX_FOLDERS), truncated: folders.length > MAX_FOLDERS };
}

/** Makes a folder named `name` inside `parent`. The parent must exist; the name must be a single, usable name. */
export async function createFolder(parentInput: string, name: string): Promise<FolderEntry> {
  const parent = absolute(parentInput);
  const clean = name.trim();
  if (!clean || clean.length > MAX_NAME_CHARS || clean === "." || clean === ".." || INVALID_NAME.test(clean) || clean.endsWith(".") || RESERVED_NAME.test(clean)) {
    throw new BrowseError("BAD_NAME", "That name cannot be used for a folder. Avoid \\ / : * ? \" < > | and names that end with a dot.");
  }
  const target = path.join(parent, clean);
  try {
    await fs.mkdir(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new BrowseError("EXISTS", `A folder named ${clean} already exists here.`);
    throw failure(err, parent);
  }
  return { name: clean, path: target };
}

async function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)));
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The drives that answer: a disconnected network drive can take a long time to say no, so each gets a second. */
async function drives(): Promise<Place[]> {
  const found = await Promise.all(
    [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map(async (letter): Promise<Place | undefined> => {
      const root = `${letter}:\\`;
      return (await withTimeout(isFolder(root), DRIVE_TIMEOUT_MS, false)) ? { kind: "drive", name: root, path: root } : undefined;
    }),
  );
  return found.filter((drive): drive is Place => drive !== undefined);
}

/** Where a person usually keeps photos, and where the file system starts, for the places a folder chooser offers first. */
export async function places(opts: { home?: string; platform?: NodeJS.Platform } = {}): Promise<{ roots: Place[]; shortcuts: Place[] }> {
  const home = opts.home ?? os.homedir();
  const candidates: [Place["kind"], string][] = [
    ["home", home],
    ["desktop", path.join(home, "Desktop")],
    ["documents", path.join(home, "Documents")],
    ["downloads", path.join(home, "Downloads")],
    ["pictures", path.join(home, "Pictures")],
    ["pictures", path.join(home, "OneDrive", "Pictures")],
    ["onedrive", path.join(home, "OneDrive")],
  ];
  const shortcuts: Place[] = [];
  for (const [kind, folder] of candidates) {
    if (shortcuts.some((s) => s.kind === kind)) continue;
    if (await isFolder(folder)) shortcuts.push({ kind, name: path.basename(folder) || folder, path: folder });
  }
  const roots: Place[] = (opts.platform ?? process.platform) === "win32" ? await drives() : [{ kind: "root", name: "/", path: "/" }];
  return { roots, shortcuts };
}

/** Where a chooser opens when nothing has been picked yet: the pictures folder, else the home folder. */
export async function startFolder(opts: { home?: string } = {}): Promise<string> {
  const { shortcuts } = await places(opts.home === undefined ? {} : { home: opts.home });
  return (shortcuts.find((s) => s.kind === "pictures") ?? shortcuts.find((s) => s.kind === "home"))?.path ?? path.parse(process.cwd()).root;
}
