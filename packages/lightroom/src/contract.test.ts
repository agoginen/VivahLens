import { expect } from "vitest";
import { adapterContract } from "@vivahlens/testkit";
import { LightroomBridge } from "./bridge.js";
import { FakePlugin, untilConnected } from "./fakePlugin.js";
import { LightroomClassicAdapter } from "./lightroomAdapter.js";

const received: { path: string; settings: Record<string, unknown> }[] = [];

/** A plugin stand-in that acknowledges every apply, and imports every file except ones that do not exist. */
async function start() {
  const bridge = new LightroomBridge();
  await bridge.start();
  const plugin = new FakePlugin(bridge, (msg) => {
    if (msg.type === "apply") {
      received.push({ path: msg.path as string, settings: msg.settings as Record<string, unknown> });
      return { ok: true };
    }
    if (msg.type === "import") {
      const paths = msg.paths as string[];
      const missing = paths.filter((p) => p.includes("never-existed"));
      return { ok: true, imported: paths.filter((p) => !missing.includes(p)), skipped: missing.map((path) => ({ path, reason: "file not found" })) };
    }
    return { ok: false, error: `unknown request ${String(msg.type)}` };
  });
  await untilConnected(bridge);
  return {
    adapter: new LightroomClassicAdapter(bridge),
    cleanup: async () => {
      plugin.stop();
      await bridge.close();
    },
  };
}

adapterContract({
  name: "lightroom-classic",
  create: start,
  asset: () => ({ id: "a", kind: "photo", path: "C:/shoot/IMG_0001.CR3" }),
  expectApplied: (asset) => {
    expect(received.at(-1)).toMatchObject({ path: asset.path, settings: { Exposure2012: 0.35 } });
  },
});
