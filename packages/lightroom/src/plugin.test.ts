import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EditRecipe } from "@vivahlens/core";
import { LightroomBridge, LIGHTROOM_HANDSHAKE_FILE } from "./bridge.js";
import { until, untilConnected } from "./fakePlugin.js";
import { LightroomClassicAdapter } from "./lightroomAdapter.js";
import { LuaHost, luaQuote, PLUGIN_DIR } from "./luaHost.js";

const HANDSHAKE = `C:\\Users\\tester\\.vivahlens\\${LIGHTROOM_HANDSHAKE_FILE}`;
const recipe: EditRecipe = { version: "1.0", assetType: "photo", adjustments: { exposure: 0.35, contrast: -12, whiteBalance: { tempK: 5200 } } };
const photo = (name: string) => ({ id: name, kind: "photo" as const, path: `C:/shoot/${name}.CR3` });

describe("the plugin's Lua is plain Lua 5.1", () => {
  /** Removes comments and string contents, so only code is left to inspect. */
  function code(source: string): string {
    let out = "";
    for (let i = 0; i < source.length; ) {
      const rest = source.slice(i);
      const skipped = /^--\[(=*)\[[\s\S]*?\]\1\]/.exec(rest) ?? /^--[^\n]*/.exec(rest) ?? /^\[(=*)\[[\s\S]*?\]\1\]/.exec(rest) ?? /^"(?:\\.|[^"\\\n])*"/.exec(rest) ?? /^'(?:\\.|[^'\\\n])*'/.exec(rest);
      if (skipped) {
        out += " ";
        i += skipped[0].length;
      } else out += source[i++];
    }
    return out;
  }

  const files = readdirSync(PLUGIN_DIR).filter((f) => f.endsWith(".lua"));

  it("has the files Info.lua points to, and only plain-ASCII sources", () => {
    expect(files.sort()).toEqual(["Bridge.lua", "Handlers.lua", "Info.lua", "Json.lua", "PluginInit.lua", "PluginShutdown.lua", "StatusDialog.lua"]);
    for (const file of files) expect(readFileSync(path.join(PLUGIN_DIR, file), "utf8"), file).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
  });

  it.each(files)("%s avoids what Lightroom's Lua 5.1 lacks", (file) => {
    const source = readFileSync(path.join(PLUGIN_DIR, file), "utf8");
    const stripped = code(source);
    const forbidden: [string, RegExp][] = [
      ["goto or a label", /\bgoto\b|::\w+::/],
      ["integer division", /\/\//],
      ["a bitwise operator", /[&|]|<<|>>|(?<![=~<>])~(?!=)/],
      ["a Lua 5.2+ library", /\b(utf8|bit32)\b|\btable\.(unpack|pack|move)\b|\bstring\.(pack|unpack|packsize)\b|\bmath\.(type|tointeger|ult)\b|\brawlen\b/],
      ["a Lua 5.4 attribute", /<(const|close)>/],
      ["load with text (5.1 spells it loadstring)", /\bload\s*\(/],
    ];
    for (const [what, pattern] of forbidden) expect(pattern.test(stripped), `${file} uses ${what}`).toBe(false);
    expect(/\\z|\\u\{|\\x[0-9A-Fa-f]{2}/.test(source), `${file} uses a string escape Lua 5.1 lacks`).toBe(false);
  });
});

describe("Json.lua", () => {
  const host = new LuaHost();
  const roundTrip = (text: string) => host.run(`local J = require('Json'); local v, e = J.decode(${luaQuote(text)}); if e then return 'ERROR: ' .. e end; return J.encode(v)`) ?? "";

  it("agrees with JavaScript's JSON on a corpus, however the keys are ordered", () => {
    const corpus = [
      "{}", "[]", "[[],{}]", '{"a":[],"b":{}}', "0", "-0.5", "1e3", "1.5e-7", "12345678901234", "0.1", "true", "false", '"plain"', '"quote \\" backslash \\\\ slash \\/"',
      '{"Exposure2012":0.35,"WhiteBalance":"Custom","Temperature":5200,"nested":{"a":[1,2,{"b":null}]}}',
      '["tab\\t","newline\\n","ctrl\\u0001","bell\\b","form\\f","cr\\r"]',
      '"caf\\u00e9 \\u4e2d\\u6587"', '"\\ud83d\\ude00"', '{"path":"C:\\\\shoot\\\\IMG_0001.CR3"}', '  { "spaced" : [ 1 , 2 ] }  ',
    ];
    for (const text of corpus) expect(JSON.parse(roundTrip(text)), text).toEqual(JSON.parse(text));
  });

  it("writes characters outside ASCII as UTF-8, joins surrogate pairs, and replaces lone surrogates", () => {
    expect(JSON.parse(roundTrip('"\\ud83d\\ude00"'))).toBe("😀");
    expect(JSON.parse(roundTrip('"caf\\u00e9"'))).toBe("café");
    expect(JSON.parse(roundTrip('"\\ud83d x"'))).toBe("\ufffd x");
    expect(JSON.parse(roundTrip('"\\ude00"'))).toBe("\ufffd");
    expect(host.run(`return require('Json').encode(${luaQuote("naïve 😀 ✓")})`)).toBe('"naïve 😀 ✓"');
  });

  it("escapes control characters and keeps empty arrays and objects apart", () => {
    expect(host.run(`return require('Json').encode(${luaQuote("a\u0001b\u007f\u0000c\"\\")})`)).toBe('"a\\u0001b\\u007f\\u0000c\\"\\\\"');
    expect(roundTrip("[]")).toBe("[]");
    expect(roundTrip("{}")).toBe("{}");
    expect(host.run("local J = require('Json'); return J.encode({ list = J.array(), map = {} })")).toBe('{"list":[],"map":{}}');
  });

  it("encodes nan and infinity as null rather than invalid JSON, and refuses what JSON cannot hold", () => {
    expect(host.run("return require('Json').encode({ a = 0/0, b = math.huge })")).toBe('{"a":null,"b":null}');
    expect(host.run("local ok, err = require('Json').encode({ f = print }); return tostring(ok) .. ' ' .. err")).toMatch(/^nil cannot encode a function/);
    expect(host.run("local ok, err = require('Json').encode({ [1] = 'a', [3] = 'c' }); return tostring(ok) .. ' ' .. err")).toMatch(/^nil a JSON object needs string keys/);
  });

  it("returns a message instead of raising on malformed text", () => {
    for (const bad of ["{", "[1,]", '{"a":}', '"abc', "tru", "", "{} x", "[1 2]", '{"a" 1}', '{1:2}', '"\\q"', '"\\u12"', "--5"]) {
      expect(roundTrip(bad), JSON.stringify(bad)).toMatch(/^ERROR: /);
    }
    expect(host.run("local v, e = require('Json').decode(nil); return e")).toBe("expected text");
    expect(roundTrip(`${"[".repeat(300)}${"]".repeat(300)}`)).toMatch(/^ERROR: .*too deep/);
  });

  it("decodes null to a sentinel that is not a table value you can mistake for data", () => {
    expect(host.run("local J = require('Json'); local v = J.decode('{\"a\":null}'); return tostring(v.a == J.null) .. ' ' .. J.encode(v)")).toBe('true {"a":null}');
  });

  it("handles a few thousand paths quickly", () => {
    const paths = Array.from({ length: 4000 }, (_, i) => `C:\\shoot\\day 1\\IMG_${String(i).padStart(4, "0")}.CR3`);
    const started = Date.now();
    const out = roundTrip(JSON.stringify({ paths }));
    expect(JSON.parse(out).paths).toEqual(paths);
    // Normally well under a second: this only catches an encoder that blows up, and a busy machine must not fail it.
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("ends well", () => {
    expect(host.errors).toEqual([]);
    host.close();
  });
});

describe("the plugin talking to a real agent bridge", () => {
  let bridge: LightroomBridge | undefined;
  let host: LuaHost | undefined;
  const extraBridges: LightroomBridge[] = [];

  afterEach(async () => {
    host?.close();
    await bridge?.close();
    for (const b of extraBridges.splice(0)) await b.close();
    const errors = host?.errors ?? [];
    host = undefined;
    bridge = undefined;
    expect(errors).toEqual([]);
  });

  async function setup(opts: { launch?: boolean } = {}) {
    bridge = new LightroomBridge({ timeoutMs: 5000 });
    await bridge.start();
    host = new LuaHost();
    host.addFile(HANDSHAKE, JSON.stringify(bridge.handshake()));
    if (opts.launch !== false) {
      host.run("import('LrFunctionContext').postAsyncTaskWithContext('test', function() require('Bridge').run({ pollWaitMs = 50 }) end)");
      await untilConnected(bridge);
      await until(() => /Status: connected/.test(host!.run("return require('Bridge').describe()") ?? ""), "the plugin to notice it is connected");
    }
    return { bridge, host, adapter: new LightroomClassicAdapter(bridge) };
  }

  it("announces itself and the Lightroom it runs in", async () => {
    const { bridge } = await setup();
    expect(bridge.connected()).toEqual({ plugin: "vivahlens-lrc", version: "1.0.0", host: "15.1" });
    expect(host!.run("return require('Bridge').describe()")).toMatch(/Status: connected to the VivahLens agent/);
  });

  it("looks for the agent in the folder the CLI writes to", async () => {
    const { host } = await setup({ launch: false });
    expect(host.run("return require('Bridge').defaultHandshakePath()")).toBe(HANDSHAKE);
    expect(HANDSHAKE.endsWith(`\\.vivahlens\\lightroom.json`)).toBe(true);
  });

  it("applies develop settings to the photo as one History step, inside a catalog write", async () => {
    const { host, adapter } = await setup();
    host.run(`__mock.addToCatalog(${luaQuote("C:\\shoot\\a.cr3")})`);

    await adapter.applyRecipe(photo("a"), recipe);

    const report = host.report();
    expect(report.history).toEqual([{ path: "C:\\shoot\\a.cr3", name: "VivahLens AI edit", settings: { Exposure2012: 0.35, Contrast2012: -12, WhiteBalance: "Custom", Temperature: 5200 } }]);
    expect(report.photos["C:\\shoot\\a.cr3"]).toMatchObject({ Exposure2012: 0.35, Temperature: 5200 });
    expect(report.writes).toEqual(["VivahLens AI edit"]);
  });

  it("says so when the photo is not in the catalog, and when Lightroom cannot be written to", async () => {
    const { host, adapter } = await setup();
    await expect(adapter.applyRecipe(photo("missing"), recipe)).rejects.toThrow(/not in the Lightroom catalog \(import it first\): C:\/shoot\/missing\.CR3/);

    host.run(`__mock.addToCatalog(${luaQuote("C:\\shoot\\a.cr3")}); __mock.busy = true`);
    await expect(adapter.applyRecipe(photo("a"), recipe)).rejects.toThrow(/could not open the catalog for writing/);
    expect(host.report().history).toEqual([]);

    host.run("__mock.busy = false; __mock.noCatalog = true");
    await expect(adapter.applyRecipe(photo("a"), recipe)).rejects.toThrow(/no catalog open/);
  });

  it("refuses settings that are not plain names with plain values", async () => {
    const { bridge, host } = await setup();
    host.run(`__mock.addToCatalog(${luaQuote("C:\\shoot\\a.cr3")})`);
    const apply = (settings: unknown) => bridge.request({ type: "apply", path: "C:/shoot/a.CR3", settings });

    await expect(apply({ "bad name!": 1 })).rejects.toThrow(/unexpected name/);
    await expect(apply({ ToneCurve: [0, 0, 255, 255] })).rejects.toThrow(/must be a number, text or a flag/);
    await expect(apply({ Exposure2012: { nested: 1 } })).rejects.toThrow(/must be a number, text or a flag/);
    await expect(apply({})).rejects.toThrow(/no settings to apply/);
    await expect(apply("Exposure2012=1")).rejects.toThrow(/needs develop settings/);
    await expect(bridge.request({ type: "apply", settings: { Exposure2012: 1 } })).rejects.toThrow(/needs the path of a photo/);
    expect(host.report().history).toEqual([]);
  });

  it("imports what it can and accounts for every file: new, already there, missing, and refused", async () => {
    const { host, adapter } = await setup();
    for (const name of ["a", "b", "d", "e"]) host.addFile(`C:\\shoot\\${name}.cr3`);
    host.run(`__mock.addToCatalog(${luaQuote("C:\\shoot\\e.cr3")}); __mock.rejects[${luaQuote("c:\\shoot\\d.cr3")}] = 'This file type is not supported.'`);

    const result = await adapter.importAssets(["a", "b", "c", "d", "e"].map(photo));

    expect(result.imported).toEqual(["a", "b", "e"]);
    expect(result.skipped).toEqual([
      { assetId: "c", reason: "file not found" },
      { assetId: "d", reason: expect.stringContaining("This file type is not supported.") },
    ]);
    expect(Object.keys(host.report().photos).sort()).toEqual(["C:\\shoot\\a.CR3", "C:\\shoot\\b.CR3", "C:\\shoot\\e.cr3"]);
  });

  it("imports a big folder in small catalog writes, reporting progress after each", async () => {
    const { host, adapter, bridge } = await setup();
    const assets = Array.from({ length: 60 }, (_, i) => photo(`IMG_${String(i).padStart(3, "0")}`));
    for (const a of assets) host.addFile(a.path.replaceAll("/", "\\"));
    const events: { done: number; total: number; stage: string }[] = [];
    const listening = (async () => {
      for await (const e of adapter.getProgress("j1")) events.push(e);
    })();

    const result = await adapter.importAssets(assets, { jobId: "j1" });
    await until(() => events.length === 3, "three progress reports");
    await bridge.progress.close();
    await listening;

    expect(result.imported).toHaveLength(60);
    expect(result.skipped).toEqual([]);
    expect(events.map((e) => [e.stage, e.done, e.total])).toEqual([["import", 25, 60], ["import", 50, 60], ["import", 60, 60]]);
    expect(host.report().writes).toEqual(["VivahLens import", "VivahLens import", "VivahLens import"]);
  });

  it("stops importing at the next batch once the agent cancels the job", async () => {
    const { host, adapter, bridge } = await setup();
    const assets = Array.from({ length: 80 }, (_, i) => photo(`IMG_${String(i).padStart(3, "0")}`));
    for (const a of assets) host.addFile(a.path.replaceAll("/", "\\"));
    const first = (async () => {
      for await (const _event of adapter.getProgress("j1")) {
        await adapter.cancel("j1");
        return;
      }
    })();

    await expect(adapter.importAssets(assets, { jobId: "j1" })).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });
    await first;
    await until(() => Object.keys(host.report().photos).length >= 50, "the batch that was already under way");
    await new Promise((r) => setTimeout(r, 300));

    // The first batch's progress report reached the agent before it cancelled; the plugin learned of the cancel from the second report.
    expect(Object.keys(host.report().photos)).toHaveLength(50);
    bridge.progress.close();
  });

  it("answers a request type it does not know, and survives a request it cannot parse", async () => {
    const { bridge } = await setup();
    await expect(bridge.request({ type: "reformat-disk" })).rejects.toThrow(/unknown request type: reformat-disk/);
    await expect(bridge.request({})).rejects.toThrow(/unknown request type: nil/);
    await expect(bridge.request({ type: "ping" })).resolves.toEqual({});
  });

  it("keeps waiting while there is no usable handshake, and connects as soon as there is one", async () => {
    const { bridge, host } = await setup({ launch: false });
    host.run(`__mock.removeFile(${luaQuote(HANDSHAKE)})`);
    host.run("import('LrFunctionContext').postAsyncTaskWithContext('test', function() require('Bridge').run({ pollWaitMs = 50 }) end)");
    await new Promise((r) => setTimeout(r, 60));
    expect(bridge.connected()).toBeUndefined();
    expect(host.run("return require('Bridge').describe()")).toMatch(/waiting for the VivahLens agent/);

    for (const junk of ["not json", '{"protocol":2,"port":1,"token":"x"}', '{"protocol":1,"port":"80","token":"x"}', '{"protocol":1,"port":80,"token":""}']) {
      host.addFile(HANDSHAKE, junk);
      await new Promise((r) => setTimeout(r, 40));
      expect(bridge.connected()).toBeUndefined();
    }

    host.addFile(HANDSHAKE, JSON.stringify(bridge.handshake()));
    await untilConnected(bridge);
  });

  it("reads the handshake again when the agent rejects its token, and does not count as connected meanwhile", async () => {
    const { bridge, host } = await setup({ launch: false });
    host.addFile(HANDSHAKE, JSON.stringify({ ...bridge.handshake(), token: "stale-token" }));
    host.run("import('LrFunctionContext').postAsyncTaskWithContext('test', function() require('Bridge').run({ pollWaitMs = 50 }) end)");
    await until(() => /did not accept/.test(host.run("return require('Bridge').describe()") ?? ""), "the rejection");
    expect(bridge.connected()).toBeUndefined();

    host.addFile(HANDSHAKE, JSON.stringify(bridge.handshake()));
    await untilConnected(bridge);
  });

  it("finds the agent again after it restarts on another port with a new token", async () => {
    const { bridge: first } = await setup();
    await first.close();
    const second = new LightroomBridge({ timeoutMs: 5000 });
    extraBridges.push(second);
    await second.start();
    expect(second.port).not.toBe(first.port);
    host!.addFile(HANDSHAKE, JSON.stringify(second.handshake()));
    await untilConnected(second);
    host!.run(`__mock.addToCatalog(${luaQuote("C:\\shoot\\a.cr3")})`);
    await expect(new LightroomClassicAdapter(second).applyRecipe(photo("a"), recipe)).resolves.toMatchObject({ assetId: "a" });
  });

  it("runs from Lightroom's own entry points: Info.lua, the init script, the status dialog and shutdown", async () => {
    const { bridge, host } = await setup({ launch: false });
    const info = JSON.parse(host.run(`
      local J = require('Json')
      local info = __runPluginFile('Info')
      return J.encode({ id = info.LrToolkitIdentifier, init = info.LrInitPlugin, shutdown = info.LrShutdownPlugin, force = info.LrForceInitPlugin,
        menu = info.LrLibraryMenuItems[1].file, sdk = info.LrSdkVersion, min = info.LrSdkMinimumVersion })`) ?? "{}");
    expect(info).toMatchObject({ id: "com.vivahlens.lightroom", init: "PluginInit.lua", shutdown: "PluginShutdown.lua", force: true, menu: "StatusDialog.lua", sdk: 13, min: 10 });

    host.runPluginFile("StatusDialog");
    await until(() => host.report().dialogs.length === 1, "the dialog");
    expect(host.report().dialogs[0]).toMatchObject({ title: "VivahLens", style: "warning", message: expect.stringContaining("Status: not started") });

    host.runPluginFile("PluginInit"); // the real entry point, with the real three-second poll
    await untilConnected(bridge);
    await until(() => /Status: connected/.test(host.run("return require('Bridge').describe()") ?? ""), "the plugin to notice it is connected");
    host.runPluginFile("StatusDialog");
    await until(() => host.report().dialogs.length === 2, "the second dialog");
    expect(host.report().dialogs[1]).toMatchObject({ style: "info", message: expect.stringContaining("connected to the VivahLens agent") });

    host.runPluginFile("PluginShutdown");
    await bridge.close(); // ends the held poll so the loop notices the stop request
    await until(() => /stopped/.test(host.run("return require('Bridge').describe()") ?? ""), "the loop to stop");
  });
});

describe("what the harness itself guarantees", () => {
  it("refuses to yield across a plain pcall, as Lightroom's Lua 5.1 does, but allows it through LrTasks.pcall", async () => {
    const host = new LuaHost();
    host.run(`
      local LrTasks = import('LrTasks')
      LrTasks.startAsyncTask(function()
        local ok, err = pcall(function() LrTasks.sleep(0) end)
        __outcome = tostring(ok) .. ' | ' .. tostring(err)
        local ok2 = LrTasks.pcall(function() LrTasks.sleep(0) end)
        __outcome2 = tostring(ok2)
      end)`);
    await until(() => host.run("return __outcome2") === "true", "both tasks");
    expect(host.run("return __outcome")).toMatch(/^false \| .*attempt to yield across a C-call boundary/);
    expect(host.errors).toEqual([]);
    host.close();
  });
});
