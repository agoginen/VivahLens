import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractPlugin, inspectPlugin, installLightroomPlugin, LIGHTROOM_PLUGIN_FOLDER, lightroomApplication, lightroomModulesDir, lightroomPluginSource, pluginVersion } from "./installPlugin.js";

const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vivah-lr-install-"));
  temps.push(dir);
  return dir;
};
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const digest = (dir: string): Record<string, string> =>
  Object.fromEntries(readdirSync(dir).sort().map((f) => [f, createHash("sha256").update(readFileSync(path.join(dir, f))).digest("hex")]));

describe("where Lightroom looks for plugins", () => {
  it("finds the Modules folder on Windows and macOS, and none elsewhere", () => {
    expect(lightroomModulesDir("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "C:\\Users\\me")).toBe(path.join("C:\\Users\\me\\AppData\\Roaming", "Adobe", "Lightroom", "Modules"));
    expect(lightroomModulesDir("win32", {}, "C:\\Users\\me")).toBeUndefined();
    expect(lightroomModulesDir("darwin", {}, "/Users/me")).toBe(path.join("/Users/me", "Library", "Application Support", "Adobe", "Lightroom", "Modules"));
    expect(lightroomModulesDir("linux", {}, "/home/me")).toBeUndefined();
    expect(lightroomApplication("win32", { ProgramFiles: "D:\\Programs" })).toBe(path.join("D:\\Programs", "Adobe", "Adobe Lightroom Classic", "Lightroom.exe"));
    expect(lightroomApplication("darwin", {})).toContain("Adobe Lightroom Classic.app");
    expect(lightroomApplication("linux", {})).toBeUndefined();
  });

  it("reads the plugin's version from its Info.lua, and says nothing when it is not there", () => {
    expect(pluginVersion("VERSION = { major = 1, minor = 2, revision = 3, build = 0 },")).toBe("1.2.3");
    expect(pluginVersion("return { VERSION = { major=10,minor=0,revision=7 } }")).toBe("10.0.7");
    expect(pluginVersion("return { }")).toBeUndefined();
    expect(pluginVersion("VERSION = { major = 1, minor = 2 }")).toBeUndefined();
    expect(pluginVersion(readFileSync(path.join(lightroomPluginSource(), "Info.lua"), "utf8"))).toBe("1.0.0");
  });
});

describe("installing the plugin", () => {
  it("copies every plugin file into Modules, creating the folder, and reports the version", async () => {
    const modules = path.join(temp(), "Adobe", "Lightroom", "Modules");
    const result = await installLightroomPlugin({ modulesDir: modules });
    expect(result).toEqual({ folder: path.join(modules, LIGHTROOM_PLUGIN_FOLDER), replaced: false, version: "1.0.0" });
    expect(digest(result.folder)).toEqual(digest(lightroomPluginSource()));
    expect(readdirSync(modules)).toEqual([LIGHTROOM_PLUGIN_FOLDER]);
    expect(await inspectPlugin(result.folder)).toEqual({ folder: result.folder, version: "1.0.0", foreign: false });
  });

  it("replaces an earlier copy of its own, leaving no stray files from it and no staging folder", async () => {
    const modules = temp();
    const old = path.join(modules, LIGHTROOM_PLUGIN_FOLDER);
    mkdirSync(old);
    writeFileSync(path.join(old, "Info.lua"), "return { LrToolkitIdentifier = 'com.vivahlens.lightroom', VERSION = { major = 0, minor = 9, revision = 0 } }");
    writeFileSync(path.join(old, "Obsolete.lua"), "-- removed in a later version");
    const result = await installLightroomPlugin({ modulesDir: modules });
    expect(result.replaced).toBe(true);
    expect(existsSync(path.join(old, "Obsolete.lua"))).toBe(false);
    expect(digest(old)).toEqual(digest(lightroomPluginSource()));
    expect(readdirSync(modules)).toEqual([LIGHTROOM_PLUGIN_FOLDER]);
  });

  it("refuses to overwrite a folder of that name that is not the VivahLens plugin", async () => {
    const modules = temp();
    const other = path.join(modules, LIGHTROOM_PLUGIN_FOLDER);
    mkdirSync(other);
    writeFileSync(path.join(other, "Info.lua"), "return { LrToolkitIdentifier = 'com.someone.else' }");
    await expect(installLightroomPlugin({ modulesDir: modules })).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED", message: expect.stringContaining("not the VivahLens plugin") });
    expect(readFileSync(path.join(other, "Info.lua"), "utf8")).toContain("com.someone.else");

    const nameless = temp();
    mkdirSync(path.join(nameless, LIGHTROOM_PLUGIN_FOLDER));
    writeFileSync(path.join(nameless, LIGHTROOM_PLUGIN_FOLDER, "notes.txt"), "mine");
    await expect(installLightroomPlugin({ modulesDir: nameless })).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED" });
    expect(await inspectPlugin(path.join(nameless, LIGHTROOM_PLUGIN_FOLDER))).toMatchObject({ foreign: true });
  });

  it("says so when the shipped plugin files are missing, and leaves Modules alone", async () => {
    const modules = temp();
    await expect(installLightroomPlugin({ modulesDir: modules, source: path.join(temp(), "nothing") })).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED", message: expect.stringContaining("missing") });
    expect(readdirSync(modules)).toEqual([]);
    expect(await inspectPlugin(path.join(modules, LIGHTROOM_PLUGIN_FOLDER))).toBeUndefined();
  });
});

describe("the plugin inside the single executable", () => {
  // What the executable holds: a manifest of file names, and each file under its own key.
  const embedded = (names: string[], files: Record<string, Buffer | string> = {}) => {
    const held = new Map<string, Buffer>([["lightroom/plugin/manifest.json", Buffer.from(JSON.stringify(names))]]);
    for (const [name, bytes] of Object.entries(files)) held.set(`lightroom/plugin/${name}`, Buffer.from(bytes));
    return (key: string) => held.get(key);
  };
  const shippedFiles = () => {
    const folder = lightroomPluginSource();
    const names = readdirSync(folder).sort();
    return { names, files: Object.fromEntries(names.map((n) => [n, readFileSync(path.join(folder, n))])) };
  };

  it("is written out as the same folder that ships beside the code, and installs from there", async () => {
    const { names, files } = shippedFiles();
    const folder = extractPlugin(embedded(names, files), temp())!;
    expect(path.basename(folder)).toBe(LIGHTROOM_PLUGIN_FOLDER);
    expect(digest(folder)).toEqual(digest(lightroomPluginSource()));
    expect(await inspectPlugin(folder)).toEqual({ folder, version: "1.0.0", foreign: false });

    const modules = temp();
    const result = await installLightroomPlugin({ modulesDir: modules, source: folder });
    expect(digest(result.folder)).toEqual(digest(lightroomPluginSource()));
  });

  it("creates the folders a file sits in", () => {
    const folder = extractPlugin(embedded(["Info.lua", "lib/Json.lua"], { "Info.lua": "a", "lib/Json.lua": "b" }), temp())!;
    expect(readFileSync(path.join(folder, "lib", "Json.lua"), "utf8")).toBe("b");
  });

  it("finds nothing, and writes nothing, when this is not the single executable", () => {
    const into = temp();
    expect(extractPlugin(() => undefined, into)).toBeUndefined();
    expect(readdirSync(into)).toEqual([]);
  });

  it("refuses a file name that would land outside the plugin folder", () => {
    for (const name of ["../escape.lua", "..\\escape.lua", "lib/../../escape.lua", path.resolve("/escape.lua"), "."]) {
      const into = temp();
      expect(() => extractPlugin(embedded([name], { [name]: "x" }), path.join(into, "inner")), name).toThrow(expect.objectContaining({ code: "ADAPTER_APPLY_FAILED", message: expect.stringContaining("damaged") }));
      expect(existsSync(path.join(into, "escape.lua")), name).toBe(false);
    }
  });

  it("says which file is missing when the executable lacks one it lists", () => {
    expect(() => extractPlugin(embedded(["Info.lua", "Gone.lua"], { "Info.lua": "a" }), temp())).toThrow(expect.objectContaining({ code: "ADAPTER_APPLY_FAILED", message: expect.stringContaining("Gone.lua") }));
  });
});
