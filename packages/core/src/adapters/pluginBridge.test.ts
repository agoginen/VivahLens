import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginBridge, removeBridgeHandshake, writeBridgeHandshake, type PluginBridgeOptions } from "./pluginBridge.js";

let bridge: PluginBridge | undefined;
const temps: string[] = [];
afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(opts?: PluginBridgeOptions) {
  bridge = new PluginBridge({ name: "Test plugin", ...opts });
  await bridge.start();
  return bridge;
}

const call = (b: PluginBridge, route: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
  const method = init.method ?? "GET";
  return fetch(`http://127.0.0.1:${b.port}${route}`, {
    method,
    headers: { "x-vivah-token": init.token ?? b.token, "content-type": "application/json" },
    ...(method === "POST" && init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
};

/** One poll as a plugin makes it; the first poll is what announces the plugin. */
const poll = async (b: PluginBridge, wait = 0) => {
  const res = await call(b, `/v1/next?wait=${wait}&plugin=test-plugin&version=1.2&host=Host%2015`);
  return res.status === 200 ? ((await res.json()) as Record<string, unknown>) : undefined;
};
const answer = (b: PluginBridge, id: unknown, body: Record<string, unknown>) => call(b, `/v1/reply/${String(id)}`, { method: "POST", body });
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe("PluginBridge requests", () => {
  it("is not connected until the plugin has polled, then carries a request to it and its reply back", async () => {
    const b = await start();
    expect(b.connected()).toBeUndefined();
    await expect(b.request({ type: "apply" })).rejects.toMatchObject({ code: "ADAPTER_EDITOR_NOT_RUNNING" });

    await poll(b);
    expect(b.connected()).toEqual({ plugin: "test-plugin", version: "1.2", host: "Host 15" });

    const asked = b.request({ type: "apply", path: "C:/a.cr3" }, { jobId: "j1" });
    const message = await poll(b, 2000);
    expect(message).toMatchObject({ type: "apply", path: "C:/a.cr3", jobId: "j1" });
    expect((await answer(b, message!.id, { ok: true, imported: ["x"] })).status).toBe(204);
    await expect(asked).resolves.toEqual({ imported: ["x"] });
  });

  it("hands a request that was made before the poll to the next poll, once", async () => {
    const b = await start();
    await poll(b);
    const asked = b.request({ type: "import" });
    const first = await poll(b);
    expect(first).toMatchObject({ type: "import" });
    expect(await poll(b)).toBeUndefined();
    await answer(b, first!.id, { ok: true });
    await asked;
  });

  it("holds a poll open until a request arrives, and gives a superseded poll its empty answer", async () => {
    const b = await start();
    await poll(b);
    const stale = call(b, "/v1/next?wait=5000");
    await new Promise((r) => setTimeout(r, 30));
    const fresh = poll(b, 5000);
    expect((await stale).status).toBe(204);

    const asked = b.request({ type: "ping" });
    const message = await fresh;
    expect(message).toMatchObject({ type: "ping" });
    await answer(b, message!.id, { ok: true });
    await asked;
  });

  it("never holds a poll longer than it allows, and treats a nonsense wait as none", async () => {
    // The cap is long enough that answering at once is clearly different from holding the poll, even on a busy machine.
    const b = await start({ maxPollMs: 1500 });
    const started = Date.now();
    expect(await poll(b, 60_000)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(10_000);
    const quick = Date.now();
    expect((await call(b, "/v1/next?wait=banana")).status).toBe(204);
    expect(Date.now() - quick).toBeLessThan(750);
  });

  it("turns the plugin's error into a failed apply and a silent plugin into a timeout", async () => {
    const b = await start({ timeoutMs: 120 });
    await poll(b);
    const refused = b.request({ type: "apply" }).catch((e: unknown) => e);
    await answer(b, (await poll(b))!.id, { ok: false, error: "photo not in catalog" });
    expect(await refused).toMatchObject({ code: "ADAPTER_APPLY_FAILED", message: expect.stringContaining("Test plugin: photo not in catalog") });

    const silent = b.request({ type: "apply" }).catch((e: unknown) => e);
    await poll(b);
    expect(String(await silent)).toMatch(/did not respond/);
  });

  it("keeps a plugin connected while it works on a long request, and drops it after it has been silent too long", async () => {
    const b = await start({ livenessMs: 60, timeoutMs: 5000 });
    await poll(b);
    const asked = b.request({ type: "import" });
    const message = await poll(b);
    await new Promise((r) => setTimeout(r, 150));
    expect(b.connected()).toBeDefined(); // busy, so not silent
    await answer(b, message!.id, { ok: true });
    await asked;
    await until(() => b.connected() === undefined);
  });
});

describe("PluginBridge cancellation", () => {
  it("drops queued requests of a cancelled job, releases the waiting callers, and tells the plugin which jobs are cancelled", async () => {
    const b = await start();
    await poll(b);
    const first = b.request({ type: "apply", n: 1 }, { jobId: "j1" });
    const second = b.request({ type: "apply", n: 2 }, { jobId: "j1" });
    const other = b.request({ type: "apply", n: 3 }, { jobId: "j2" });
    const delivered = await poll(b); // n=1 is now with the plugin; n=2 and n=3 are still queued
    expect(delivered).toMatchObject({ n: 1 });

    b.cancelJob("j1");
    await expect(first).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });
    await expect(second).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });

    // Only the other job's request is left to hand out; the cancelled job's late reply goes nowhere.
    const next = await poll(b);
    expect(next).toMatchObject({ n: 3 });
    expect((await answer(b, delivered!.id, { ok: true })).status).toBe(404);
    await answer(b, next!.id, { ok: true });
    await expect(other).resolves.toEqual({});

    const progress = await call(b, "/v1/progress", { method: "POST", body: { stage: "apply", done: 1, total: 2 } });
    expect(await progress.json()).toEqual({ cancelled: ["j1"] });
  });

  it("cancels one request when its signal fires, and refuses to send one that is already cancelled", async () => {
    const b = await start();
    await poll(b);
    const controller = new AbortController();
    const asked = b.request({ type: "apply" }, { jobId: "j1", signal: controller.signal });
    const delivered = await poll(b);
    controller.abort();
    await expect(asked).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });
    expect((await answer(b, delivered!.id, { ok: true })).status).toBe(404);

    await expect(b.request({ type: "apply" }, { jobId: "j1", signal: controller.signal })).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });
    expect(await poll(b)).toBeUndefined();
  });

  it("remembers only the most recent cancellations", async () => {
    const b = await start();
    for (let i = 0; i < 130; i++) b.cancelJob(`job-${i}`);
    const { cancelled } = (await (await call(b, "/v1/progress", { method: "POST", body: { stage: "s", done: 0, total: 0 } })).json()) as { cancelled: string[] };
    expect(cancelled).toHaveLength(100);
    expect(cancelled[0]).toBe("job-30");
    expect(cancelled.at(-1)).toBe("job-129");
  });
});

describe("PluginBridge progress", () => {
  it("relays well-formed progress and drops anything else", async () => {
    const b = await start();
    const events: unknown[] = [];
    const listening = (async () => {
      for await (const e of b.progress.subscribe("j1")) events.push(e);
    })();
    for (const body of [
      { jobId: "j1", assetId: "a", stage: "apply", done: 1, total: 5, message: "Applying" },
      { jobId: "j2", stage: "apply", done: 9, total: 9 },
      { jobId: "j1", stage: 7, done: 1, total: 5 },
      { jobId: "j1", stage: "apply", done: "many", total: 5 },
      { jobId: "j1", stage: "apply", done: 2, total: 5 },
    ]) {
      expect((await call(b, "/v1/progress", { method: "POST", body })).status).toBe(200);
    }
    await until(() => events.length === 2);
    await b.progress.close();
    await listening;
    expect(events).toEqual([
      { jobId: "j1", assetId: "a", stage: "apply", done: 1, total: 5, message: "Applying" },
      { jobId: "j1", stage: "apply", done: 2, total: 5 },
    ]);
  });
});

describe("PluginBridge access control", () => {
  it("answers 401 without revealing anything when the token is missing or wrong, and never queues for such a caller", async () => {
    const b = await start();
    for (const token of ["", "wrong", `${b.token}x`, b.token.slice(1)]) {
      for (const route of ["/v1/ping", "/v1/next?wait=0&plugin=evil&version=1", "/v1/progress"]) {
        const res = await call(b, route, { token, method: route.endsWith("progress") ? "POST" : "GET", body: { stage: "s", done: 1, total: 1 } });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
      }
    }
    expect(b.connected()).toBeUndefined();
    expect((await call(b, "/v1/ping")).status).toBe(200);
  });

  it("refuses a request whose Host is not the loopback address (DNS rebinding), even with the token", async () => {
    const b = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: b.port, path: "/v1/ping", headers: { Host: "attacker.example", "x-vivah-token": b.token } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("rejects malformed bodies and unknown routes or request ids, and answers a body that is too large with an error", async () => {
    const b = await start();
    await poll(b);
    const bad = await fetch(`http://127.0.0.1:${b.port}/v1/progress`, { method: "POST", headers: { "x-vivah-token": b.token }, body: "{not json" });
    expect(bad.status).toBe(400);
    const array = await fetch(`http://127.0.0.1:${b.port}/v1/reply/abc`, { method: "POST", headers: { "x-vivah-token": b.token }, body: "[1]" });
    expect(array.status).toBe(400);
    expect((await answer(b, "no-such-request", { ok: true })).status).toBe(404);
    expect((await call(b, "/v1/nope")).status).toBe(404);
    expect((await call(b, "/v1/next", { method: "POST", body: {} })).status).toBe(404);
    expect((await call(b, "/v1/reply/../../etc", { method: "POST", body: {} })).status).toBe(404);
    const huge = await fetch(`http://127.0.0.1:${b.port}/v1/progress`, { method: "POST", headers: { "x-vivah-token": b.token }, body: JSON.stringify({ stage: "x".repeat(5_000_000), done: 1, total: 1 }) });
    expect(huge.status).toBe(400);
  });

  it("listens on loopback only, and a fixed token can be supplied for plugins that are paired once", async () => {
    const b = await start({ token: "paired-by-hand" });
    expect(b.token).toBe("paired-by-hand");
    expect(((b as unknown as { server: http.Server }).server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("does not hang on close while a poll is held or a connection is idle", async () => {
    const b = await start();
    const held = call(b, "/v1/next?wait=20000&plugin=p&version=1");
    await new Promise((r) => setTimeout(r, 30));
    const started = Date.now();
    await b.close();
    bridge = undefined;
    expect((await held).status).toBe(204);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("bridge handshake file", () => {
  const tempFile = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "vivah-bridge-"));
    temps.push(dir);
    return path.join(dir, "nested", "lightroom.json");
  };

  it("writes the port and token atomically, creating the folder, and replaces an older file", async () => {
    const file = tempFile();
    const b = await start();
    await writeBridgeHandshake(file, b.handshake());
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ protocol: 1, port: b.port, token: b.token });
    await writeBridgeHandshake(file, { protocol: 1, port: 1, token: "newer" });
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe("newer");
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it("removes only its own handshake, and tolerates a missing or corrupt file", async () => {
    const file = tempFile();
    await writeBridgeHandshake(file, { protocol: 1, port: 5, token: "mine" });
    await removeBridgeHandshake(file, "someone-else");
    expect(existsSync(file)).toBe(true);
    await removeBridgeHandshake(file, "mine");
    expect(existsSync(file)).toBe(false);
    await removeBridgeHandshake(file, "mine");
    writeFileSync(`${file}.corrupt`, "{oops");
    await removeBridgeHandshake(`${file}.corrupt`, "mine");
  });
});
