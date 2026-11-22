import { afterEach, describe, expect, it } from "vitest";
import type { EditRecipe } from "@vivahlens/core";
import { LightroomBridge } from "./bridge.js";
import { FakePlugin, until, untilConnected } from "./fakePlugin.js";
import { compileToDevelopSettings, LightroomClassicAdapter } from "./lightroomAdapter.js";

const recipe: EditRecipe = {
  version: "1.0",
  assetType: "photo",
  adjustments: { exposure: 0.35, contrast: -12, whiteBalance: { tempK: 5200 } },
};
const asset = { id: "a", kind: "photo" as const, path: "C:/shoot/a.CR3" };

let bridge: LightroomBridge | undefined;
const plugins: FakePlugin[] = [];
afterEach(async () => {
  plugins.splice(0).forEach((p) => p.stop());
  await bridge?.close();
  bridge = undefined;
});

async function start(timeoutMs?: number) {
  bridge = new LightroomBridge({ ...(timeoutMs && { timeoutMs }) });
  await bridge.start();
  return bridge;
}

async function pluginFor(b: LightroomBridge, handle: ConstructorParameters<typeof FakePlugin>[1]) {
  const plugin = new FakePlugin(b, handle);
  plugins.push(plugin);
  await untilConnected(b);
  return plugin;
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

describe("Lightroom plugin connection", () => {
  it("is found once the plugin polls, sends settings for the file, and resolves on the plugin's reply", async () => {
    const b = await start();
    const adapter = new LightroomClassicAdapter(b);
    expect(await adapter.detect()).toBeNull();

    const plugin = await pluginFor(b, () => ({ ok: true }));
    expect(await adapter.detect()).toEqual({ version: "1.0" });

    await expect(adapter.applyRecipe(asset, recipe)).resolves.toEqual({ assetId: "a", outputs: [] });
    expect(plugin.seen).toMatchObject([{ type: "apply", path: asset.path, settings: { Exposure2012: 0.35, Temperature: 5200 } }]);
  });

  it("reports Lightroom's own version when the plugin gives it", async () => {
    const b = await start();
    const plugin = new FakePlugin(b, () => ({ ok: true }), { plugin: "vivahlens-lrc", version: "1.0", host: "15.1" });
    plugins.push(plugin);
    await untilConnected(b);
    expect(await new LightroomClassicAdapter(b).detect()).toEqual({ version: "15.1" });
  });

  it("does not treat a plugin with the wrong token as connected", async () => {
    const b = await start();
    plugins.push(new FakePlugin({ port: b.port, token: "wrong-token" }, () => ({ ok: true })));
    await new Promise((r) => setTimeout(r, 80));
    await expect(new LightroomClassicAdapter(b).applyRecipe(asset, recipe)).rejects.toMatchObject({ code: "ADAPTER_EDITOR_NOT_RUNNING" });
  });

  it("surfaces plugin errors and timeouts as apply failures", async () => {
    const b = await start(150);
    const adapter = new LightroomClassicAdapter(b);
    let mode: "error" | "silent" = "error";
    await pluginFor(b, () => (mode === "error" ? { ok: false, error: "photo not in catalog" } : new Promise<never>(() => undefined)));

    await expect(adapter.applyRecipe(asset, recipe)).rejects.toThrow(/photo not in catalog/);
    mode = "silent";
    await expect(adapter.applyRecipe(asset, recipe)).rejects.toThrow(/did not respond/);
  });
});

describe("importing into the Lightroom catalog", () => {
  it("matches the plugin's spelling of each path, and never silently drops a file it did not mention", async () => {
    const b = await start();
    const adapter = new LightroomClassicAdapter(b);
    // Lightroom spells the first path with backslashes and another case, refuses the second, and says nothing of the third.
    const plugin = await pluginFor(b, () => ({ ok: true, imported: ["C:\\SHOOT\\A.cr3"], skipped: [{ path: "c:/shoot/b.cr3", reason: "unsupported format" }] }));

    const result = await adapter.importAssets(
      [{ id: "a", kind: "photo", path: "C:/shoot/a.CR3" }, { id: "b", kind: "photo", path: "C:/shoot/b.CR3" }, { id: "c", kind: "photo", path: "C:/shoot/c.CR3" }],
      { jobId: "j1" },
    );

    expect(result.imported).toEqual(["a"]);
    expect(result.skipped).toEqual([
      { assetId: "b", reason: "unsupported format" },
      { assetId: "c", reason: "Lightroom did not say whether it imported this file" },
    ]);
    expect(plugin.seen[0]).toMatchObject({ type: "import", jobId: "j1", paths: ["C:/shoot/a.CR3", "C:/shoot/b.CR3", "C:/shoot/c.CR3"] });
  });

  it("copes with a reply of the wrong shape instead of crashing", async () => {
    const b = await start();
    await pluginFor(b, () => ({ ok: true, imported: "everything", skipped: [42, { path: 7 }] }));
    const result = await new LightroomClassicAdapter(b).importAssets([asset]);
    expect(result.imported).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });
});

describe("cancelling work in Lightroom", () => {
  it("releases the photos of a cancelled job, keeps the other job's, and ignores the late reply", async () => {
    const b = await start();
    const adapter = new LightroomClassicAdapter(b);
    const release: Array<(reply: Record<string, unknown>) => void> = [];
    const plugin = await pluginFor(b, () => new Promise((resolve) => release.push(resolve))); // answers only when the test says so

    const mine = adapter.applyRecipe(asset, recipe, { jobId: "j1" });
    await until(() => release.length === 1, "the plugin to take the first photo");
    const other = adapter.applyRecipe({ ...asset, id: "b", path: "C:/shoot/b.CR3" }, recipe, { jobId: "j2" });

    await adapter.cancel("j1");
    await expect(mine).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });
    expect(await plugin.progress({ stage: "apply", done: 1, total: 2 })).toEqual({ cancelled: ["j1"] });

    // The plugin was still busy with the cancelled photo; once it finishes it moves on to the other job's.
    release[0]!({ ok: true });
    await until(() => release.length === 2, "the plugin to take the second photo");
    release[1]!({ ok: true });
    await expect(other).resolves.toMatchObject({ assetId: "b" });
    expect(plugin.seen.map((m) => m.jobId)).toEqual(["j1", "j2"]);
  });

  it("never sends a request for a job whose signal has fired, and drops it from the queue when it fires later", async () => {
    const b = await start();
    const adapter = new LightroomClassicAdapter(b);
    const release: Array<(reply: Record<string, unknown>) => void> = [];
    const plugin = await pluginFor(b, () => new Promise((resolve) => release.push(resolve)));
    const controller = new AbortController();

    const busy = adapter.applyRecipe(asset, recipe, { jobId: "j0" });
    await until(() => release.length === 1, "the plugin to be busy");
    const queued = adapter.applyRecipe(asset, recipe, { jobId: "j1", signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });
    await expect(adapter.applyRecipe(asset, recipe, { jobId: "j1", signal: controller.signal })).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });

    release[0]!({ ok: true });
    await busy;
    await new Promise((r) => setTimeout(r, 400)); // several polls: the cancelled requests must never reach the plugin
    expect(plugin.seen.map((m) => m.jobId)).toEqual(["j0"]);
  });
});

describe("progress from the plugin", () => {
  it("relays progress for the job asked about", async () => {
    const b = await start();
    const adapter = new LightroomClassicAdapter(b);
    const plugin = await pluginFor(b, () => undefined);
    const events: unknown[] = [];
    const listening = (async () => {
      for await (const e of adapter.getProgress("j1")) events.push(e);
    })();

    await plugin.progress({ jobId: "j1", assetId: "a", stage: "apply", done: 1, total: 5, message: "Applying" });
    await plugin.progress({ jobId: "j2", stage: "apply", done: 9, total: 9 });
    await until(() => events.length === 1, "the progress event");
    await b.progress.close();
    await listening;
    expect(events).toEqual([{ jobId: "j1", assetId: "a", stage: "apply", done: 1, total: 5, message: "Applying" }]);
  });
});
