import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { EditRecipe } from "@vivahlens/core";
import { PluginIpcServer } from "./ipc.js";
import { compileToDevelopSettings, LightroomClassicAdapter } from "./lightroomAdapter.js";

const recipe: EditRecipe = {
  version: "1.0",
  assetType: "photo",
  adjustments: { exposure: 0.35, contrast: -12, whiteBalance: { tempK: 5200 } },
};
const asset = { id: "a", kind: "photo" as const, path: "C:/shoot/a.CR3" };

/** Stands in for the Lua plugin: connects, authenticates, and answers apply requests. */
async function connectPlugin(
  port: number,
  token: string,
  onApply: (msg: { path: string; settings: Record<string, unknown> }) => { ok: boolean; error?: string },
) {
  const socket = net.connect(port, "127.0.0.1");
  socket.setEncoding("utf8");
  const ready = new Promise<string>((resolve) => {
    let buf = "";
    socket.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (msg.type === "ready") resolve("ready");
        if (msg.type === "apply") socket.write(`${JSON.stringify({ id: msg.id, ...onApply(msg) })}\n`);
      }
    });
    socket.on("close", () => resolve("closed"));
  });
  socket.write(`${JSON.stringify({ type: "hello", token, plugin: "vivahlens-lrc", version: "1.0" })}\n`);
  return { socket, outcome: ready };
}

let server: PluginIpcServer | undefined;
const sockets: net.Socket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.destroy());
  await server?.close();
  server = undefined;
});

async function start(timeoutMs?: number) {
  server = new PluginIpcServer({ timeoutMs });
  await server.start();
  return server;
}

describe("compileToDevelopSettings", () => {
  it("emits numeric Camera Raw settings without XMP bookkeeping keys", () => {
    expect(compileToDevelopSettings(recipe)).toEqual({
      Exposure2012: 0.35,
      Contrast2012: -12,
      WhiteBalance: "Custom",
      Temperature: 5200,
    });
  });
});

describe("Lightroom plugin IPC", () => {
  it("authenticates the plugin, sends settings for the file, and resolves on its reply", async () => {
    const s = await start();
    const adapter = new LightroomClassicAdapter(s);
    expect(await adapter.detect()).toBeNull();

    const applied: unknown[] = [];
    const plugin = await connectPlugin(s.port, s.token, (m) => (applied.push(m), { ok: true }));
    sockets.push(plugin.socket);
    expect(await plugin.outcome).toBe("ready");
    expect(await adapter.detect()).toEqual({ version: "1.0" });

    await expect(adapter.applyRecipe(asset, recipe)).resolves.toEqual({ assetId: "a", outputs: [] });
    expect(applied).toMatchObject([{ path: asset.path, settings: { Exposure2012: 0.35, Temperature: 5200 } }]);
  });

  it("closes connections that present a wrong token and keeps reporting not-connected", async () => {
    const s = await start();
    const plugin = await connectPlugin(s.port, "wrong-token", () => ({ ok: true }));
    sockets.push(plugin.socket);
    expect(await plugin.outcome).toBe("closed");
    await expect(new LightroomClassicAdapter(s).applyRecipe(asset, recipe)).rejects.toMatchObject({
      code: "ADAPTER_EDITOR_NOT_RUNNING",
    });
  });

  it("surfaces plugin errors and timeouts as apply failures", async () => {
    const s = await start(150);
    const adapter = new LightroomClassicAdapter(s);
    let mode: "error" | "silent" = "error";
    const plugin = await connectPlugin(s.port, s.token, () => (mode === "error" ? { ok: false, error: "photo not in catalog" } : (undefined as never)));
    sockets.push(plugin.socket);
    await plugin.outcome;

    await expect(adapter.applyRecipe(asset, recipe)).rejects.toThrow(/photo not in catalog/);
    mode = "silent";
    plugin.socket.removeAllListeners("data");
    await expect(adapter.applyRecipe(asset, recipe)).rejects.toThrow(/did not respond/);
  });

  it("ignores garbage before authentication and only binds to loopback", async () => {
    const s = await start();
    const socket = net.connect(s.port, "127.0.0.1");
    sockets.push(socket);
    const closed = new Promise((resolve) => socket.on("close", resolve));
    socket.write("not json\n");
    await closed;
    expect(((s as unknown as { server: net.Server }).server.address() as net.AddressInfo).address).toBe("127.0.0.1");
  });
});
