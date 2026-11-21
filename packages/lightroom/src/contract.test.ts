import net from "node:net";
import { expect } from "vitest";
import { adapterContract } from "@vivahlens/testkit";
import { PluginIpcServer } from "./ipc.js";
import { LightroomClassicAdapter } from "./lightroomAdapter.js";

const received: { path: string; settings: Record<string, unknown> }[] = [];

/** A plugin stand-in that authenticates and acknowledges every apply request. */
async function start() {
  const server = new PluginIpcServer();
  await server.start();
  const socket = net.connect(server.port, "127.0.0.1");
  socket.setEncoding("utf8");
  const ready = new Promise<void>((resolve) => {
    let buf = "";
    socket.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (msg.type === "ready") resolve();
        if (msg.type === "apply") {
          received.push({ path: msg.path, settings: msg.settings });
          socket.write(`${JSON.stringify({ id: msg.id, ok: true })}\n`);
        }
      }
    });
  });
  socket.write(`${JSON.stringify({ type: "hello", token: server.token, plugin: "vivahlens-lrc", version: "1.0" })}\n`);
  await ready;
  return {
    adapter: new LightroomClassicAdapter(server),
    cleanup: async () => {
      socket.destroy();
      await server.close();
    },
  };
}

adapterContract({
  name: "lightroom-classic",
  create: start,
  photo: () => ({ id: "a", kind: "photo", path: "C:/shoot/IMG_0001.CR3" }),
  expectApplied: (asset) => {
    expect(received.at(-1)).toMatchObject({ path: asset.path, settings: { Exposure2012: 0.35 } });
  },
});
