import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lauxlib, lua, lualib, to_luastring } from "fengari";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = path.resolve(here, "../plugin/VivahLens.lrdevplugin");
const MOCKS_FILE = path.resolve(here, "../test/lrMocks.lua");

/** A Lua string literal for any text, using decimal escapes so no byte can end the literal early. */
export function luaQuote(text: string): string {
  const escaped = [...Buffer.from(text, "utf8")].map((b) => (b >= 32 && b < 127 && b !== 34 && b !== 92 ? String.fromCharCode(b) : `\\${String(b).padStart(3, "0")}`));
  return `"${escaped.join("")}"`;
}

export interface LuaHostOptions {
  /** Real seconds per simulated second of `LrTasks.sleep`. */
  sleepScale?: number;
}

type Arg = string | number | undefined;

/**
 * Runs the plugin's real Lua code (under Lua 5.3 in the Fengari VM, restricted to the Lua 5.1 library that Lightroom
 * embeds) against test/lrMocks.lua, with real HTTP so the plugin talks to a real agent bridge.
 * Tasks are coroutines; waiting on a timer or on HTTP hands control back here, and the answer resumes the task.
 */
export class LuaHost {
  /** Lua errors that escaped a task or a callback. A test passes only when this stays empty. */
  readonly errors: string[] = [];
  private readonly L: any;
  private readonly scale: number;
  private readonly requests = new Set<AbortController>();
  private closed = false;

  constructor(opts: LuaHostOptions = {}) {
    this.scale = opts.sleepScale ?? 0.004;
    this.L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(this.L);
    this.installHost();
    const mocks = readFileSync(MOCKS_FILE, "utf8");
    const code = to_luastring(mocks);
    this.check(lauxlib.luaL_loadbuffer(this.L, code, code.length, to_luastring("@lrMocks.lua")) || lua.lua_pcall(this.L, 0, 0, 0));
  }

  /** Runs Lua code; returns its result when that is a string or a number (as text). */
  run(code: string): string | undefined {
    const L = this.L;
    const top = lua.lua_gettop(L);
    const loaded = lauxlib.luaL_loadstring(L, to_luastring(code)) || lua.lua_pcall(L, 0, 1, 0);
    if (loaded !== lua.LUA_OK) {
      const message = lua.lua_tojsstring(L, -1);
      lua.lua_settop(L, top);
      throw new Error(`Lua: ${message}`);
    }
    const result = lua.lua_isstring(L, -1) ? lua.lua_tojsstring(L, -1) : undefined;
    lua.lua_settop(L, top);
    return result as string | undefined;
  }

  /** Runs a script from the plugin folder the way Lightroom runs an entry point (Info.lua's LrInitPlugin and menu files). */
  runPluginFile(name: string): void {
    this.run(`__runPluginFile(${luaQuote(name)})`);
  }

  /** The mock Lightroom's view of the world: catalog contents, history steps, dialogs, logs. */
  report(): { photos: Record<string, Record<string, unknown>>; history: { path: string; name: string; settings: Record<string, unknown> }[]; writes: string[]; dialogs: { title: string; message: string; style: string }[]; logs: string[] } {
    return JSON.parse(this.run("return __mock.report()") ?? "{}");
  }

  addFile(filePath: string, text?: string): void {
    this.run(`__mock.addFile(${luaQuote(filePath)}${text === undefined ? "" : `, ${luaQuote(text)}`})`);
  }

  /** Stops the plugin's loop, abandons requests in flight, and ignores anything that answers afterwards. */
  close(): void {
    if (this.closed) return;
    try {
      this.run("require('Bridge').stop()");
    } catch {
      // The plugin may never have been loaded.
    }
    this.closed = true;
    for (const controller of this.requests) controller.abort();
  }

  private check(status: number): void {
    if (status === lua.LUA_OK) return;
    const message = lua.lua_tojsstring(this.L, -1);
    throw new Error(`Lua: ${message}`);
  }

  private keep(index: number): number {
    lua.lua_pushvalue(this.L, index);
    return lauxlib.luaL_ref(this.L, lua.LUA_REGISTRYINDEX);
  }

  /** Calls the Lua function kept under `ref` (a task's resume step) with plain arguments. */
  private resume(ref: number, args: Arg[]): void {
    const L = this.L;
    if (this.closed) return;
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
    lauxlib.luaL_unref(L, lua.LUA_REGISTRYINDEX, ref);
    for (const arg of args) {
      if (arg === undefined) lua.lua_pushnil(L);
      else if (typeof arg === "number") lua.lua_pushinteger(L, arg);
      else lua.lua_pushstring(L, to_luastring(arg));
    }
    if (lua.lua_pcall(L, args.length, 0, 0) !== lua.LUA_OK) {
      this.errors.push(String(lua.lua_tojsstring(L, -1)));
      lua.lua_pop(L, 1);
    }
  }

  private installHost(): void {
    const L = this.L;
    lua.lua_newtable(L);
    const define = (name: string, fn: (state: unknown) => number) => {
      lua.lua_pushjsfunction(L, fn);
      lua.lua_setfield(L, -2, to_luastring(name));
    };

    define("taskFailed", (state) => {
      this.errors.push(String(lua.lua_tojsstring(state, 1)));
      return 0;
    });

    define("sleep", (state) => {
      const seconds = Number(lua.lua_tonumber(state, 1));
      const ref = this.keep(2);
      setTimeout(() => this.resume(ref, []), Math.max(0, seconds * this.scale * 1000));
      return 0;
    });

    define("http", (state) => {
      const method = String(lua.lua_tojsstring(state, 1));
      const url = String(lua.lua_tojsstring(state, 2));
      const headerText = String(lua.lua_tojsstring(state, 3));
      const body = lua.lua_isnil(state, 4) ? undefined : String(lua.lua_tojsstring(state, 4));
      const timeoutSeconds = Number(lua.lua_tonumber(state, 5));
      const ref = this.keep(6);
      const headers = Object.fromEntries(
        headerText.split("\n").filter(Boolean).map((line) => {
          const at = line.indexOf(": ");
          return [line.slice(0, at), line.slice(at + 2)] as const;
        }),
      );
      const controller = new AbortController();
      this.requests.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
      fetch(url, { method, headers, ...(body !== undefined && { body }), signal: controller.signal })
        .then(async (res) => this.resume(ref, [res.status, await res.text()]))
        .catch((error: unknown) => this.resume(ref, [undefined, undefined, String(error)]))
        .finally(() => {
          clearTimeout(timer);
          this.requests.delete(controller);
        });
      return 0;
    });

    define("source", (state) => {
      const name = String(lua.lua_tojsstring(state, 1));
      const file = path.join(PLUGIN_DIR, `${name}.lua`);
      if (!/^[A-Za-z]+$/.test(name) || !existsSync(file)) {
        lua.lua_pushnil(state);
        return 1;
      }
      lua.lua_pushstring(state, to_luastring(readFileSync(file, "utf8")));
      return 1;
    });

    lua.lua_setglobal(L, to_luastring("__host"));
  }
}
