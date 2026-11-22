import { mkdirSync, mkdtempSync, rmSync, writeFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedAsset, VivahError } from "@vivahlens/core";

export const LIGHTROOM_PLUGIN_FOLDER = "VivahLens.lrdevplugin";
const TOOLKIT_ID = "com.vivahlens.lightroom";
const EMBEDDED_PLUGIN = "lightroom/plugin";

/**
 * Writes the plugin held in a single executable's assets into `into` and returns its folder, or undefined when there is none.
 * An executable has no folders to look in, so a manifest lists the files.
 */
export function extractPlugin(read: (key: string) => Buffer | undefined, into: string): string | undefined {
  const manifest = read(`${EMBEDDED_PLUGIN}/manifest.json`);
  if (!manifest) return undefined;
  const folder = path.join(into, LIGHTROOM_PLUGIN_FOLDER);
  for (const name of JSON.parse(manifest.toString("utf8")) as string[]) {
    const target = path.resolve(folder, name);
    const inside = path.relative(folder, target);
    if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) throw new VivahError("ADAPTER_APPLY_FAILED", `The plugin files in this build are damaged (${name}).`);
    const bytes = read(`${EMBEDDED_PLUGIN}/${name}`);
    if (!bytes) throw new VivahError("ADAPTER_APPLY_FAILED", `The plugin file ${name} is missing from this build.`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  return folder;
}

let embeddedFolder: string | undefined;

/** The plugin out of the single executable, written once to a folder of its own that goes away when the program exits. */
function embeddedPlugin(): string | undefined {
  if (embeddedFolder) return embeddedFolder;
  if (!embeddedAsset(`${EMBEDDED_PLUGIN}/manifest.json`)) return undefined;
  const root = mkdtempSync(path.join(os.tmpdir(), "vivahlens-plugin-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  embeddedFolder = extractPlugin(embeddedAsset, root);
  return embeddedFolder;
}

/** The plugin's files as they ship: inside the single executable, else next to this package. */
export function lightroomPluginSource(): string {
  return embeddedPlugin() ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugin", LIGHTROOM_PLUGIN_FOLDER);
}

/**
 * The folder Lightroom Classic loads plugins from without being told where they are: `Modules` under the user's
 * Lightroom settings. (Plugin Manager's "Add" can also point at a plugin anywhere.)
 */
export function lightroomModulesDir(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string | undefined {
  if (platform === "win32") return env.APPDATA ? path.join(env.APPDATA, "Adobe", "Lightroom", "Modules") : undefined;
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Adobe", "Lightroom", "Modules");
  return undefined;
}

/** Where Lightroom Classic itself is, when it is installed in the usual place. */
export function lightroomApplication(platform: NodeJS.Platform, env: Record<string, string | undefined>): string | undefined {
  if (platform === "win32") return path.join(env.ProgramFiles ?? "C:\\Program Files", "Adobe", "Adobe Lightroom Classic", "Lightroom.exe");
  if (platform === "darwin") return "/Applications/Adobe Lightroom Classic/Adobe Lightroom Classic.app";
  return undefined;
}

/** The plugin's version from its Info.lua, e.g. "1.0.0". */
export function pluginVersion(infoLua: string): string | undefined {
  const block = /VERSION\s*=\s*\{([^}]*)\}/.exec(infoLua)?.[1];
  if (!block) return undefined;
  const part = (name: string) => new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(block)?.[1];
  const [major, minor, revision] = [part("major"), part("minor"), part("revision")];
  return major === undefined || minor === undefined || revision === undefined ? undefined : `${major}.${minor}.${revision}`;
}

export interface InstalledPlugin {
  folder: string;
  version?: string;
  /** The folder holds something else under the same name (not ours to touch). */
  foreign: boolean;
}

/** What is installed at `folder`, or undefined when nothing is. */
export async function inspectPlugin(folder: string): Promise<InstalledPlugin | undefined> {
  let info: string;
  try {
    info = await fs.readFile(path.join(folder, "Info.lua"), "utf8");
  } catch {
    return (await fs.stat(folder).then(() => true, () => false)) ? { folder, foreign: true } : undefined;
  }
  const version = pluginVersion(info);
  return { folder, foreign: !info.includes(TOOLKIT_ID), ...(version && { version }) };
}

export interface InstallResult {
  folder: string;
  version?: string;
  /** An earlier copy was replaced. */
  replaced: boolean;
}

/**
 * Puts the plugin where Lightroom looks for plugins. An earlier copy of ours is replaced; a folder of the same name that
 * is not ours is refused. Lightroom has to be restarted, or the plugin reloaded in Plugin Manager, to pick it up.
 */
export async function installLightroomPlugin(opts: { modulesDir: string; source?: string }): Promise<InstallResult> {
  const source = opts.source ?? lightroomPluginSource();
  const target = path.join(opts.modulesDir, LIGHTROOM_PLUGIN_FOLDER);
  const shipped = await inspectPlugin(source);
  if (!shipped || shipped.foreign) throw new VivahError("ADAPTER_APPLY_FAILED", `The plugin files are missing from ${source}.`);
  const existing = await inspectPlugin(target);
  if (existing?.foreign) throw new VivahError("ADAPTER_APPLY_FAILED", `${target} already holds something that is not the VivahLens plugin, so it was left alone.`);
  await fs.mkdir(opts.modulesDir, { recursive: true });
  // Copy beside the old one and swap, so a failure never leaves Lightroom with half a plugin.
  const staging = `${target}.new`;
  await fs.rm(staging, { recursive: true, force: true });
  await fs.cp(source, staging, { recursive: true });
  await fs.rm(target, { recursive: true, force: true });
  await fs.rename(staging, target);
  return { folder: target, replaced: existing !== undefined, ...(shipped.version && { version: shipped.version }) };
}
