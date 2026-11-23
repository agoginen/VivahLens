import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryStore,
  type AssetRef,
  type EditorAdapter,
  type EditRecipe,
  type StyleProfile,
} from "@vivahlens/core";
import { startReviewServer, type ReviewServer } from "./server.js";
import type { ReviewDeps } from "./session.js";
import { reviewPage } from "./ui.js";

const recipe = (exposure: number): EditRecipe => ({ version: "1.0", assetType: "photo", adjustments: { exposure, contrast: 5 } });
const assets: AssetRef[] = ["a.cr3", "b.cr3"].map((id) => ({ id, kind: "photo", path: `/shoot/${id}` }));
const profile: StyleProfile = { id: "p", name: "Warm", version: 1, summary: "", baseAdjustments: { exposure: 0 } };

function setup() {
  const store = new MemoryStore();
  store.ensureJob({ id: "j", name: "j", adapterId: "fake", styleProfileId: "p", createdAt: "" });
  for (const a of assets) store.putItem({ jobId: "j", assetId: a.id, state: "review", recipe: recipe(0.5), attempts: 0 });
  const applied: { id: string; exposure?: number }[] = [];
  const adapter: EditorAdapter = {
    id: "fake",
    capabilities: { mediaKinds: ["photo"], executionModel: "local-cli", requiresGuiOpen: false, os: ["windows"], supportedRecipeFields: ["exposure"] },
    detect: async () => ({}),
    applyRecipe: async (asset, r) => (applied.push({ id: asset.id, exposure: r.adjustments.exposure }), { assetId: asset.id, outputs: [] }),
  };
  const updates: StyleProfile[] = [];
  return { store, applied, updates, adapter };
}

let server: ReviewServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(s: ReturnType<typeof setup>, extra: Partial<ReviewDeps> = {}) {
  server = await startReviewServer({
    store: s.store,
    jobId: "j",
    assets,
    adapter: s.adapter,
    profile,
    previewOf: async () => ({ mediaType: "image/jpeg", dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") }),
    onProfileUpdated: (p) => void s.updates.push(p),
    ...extra,
  });
  const base = new URL(server.url);
  const token = base.searchParams.get("t")!;
  const api = (path: string, init?: RequestInit) => fetch(`${base.origin}${path}${path.includes("?") ? "&" : "?"}t=${token}`, init);
  return { base, token, api };
}

describe("review server", () => {
  it("puts the token in an attribute, escaped, and runs no inline script", () => {
    const html = reviewPage('a"></head><script>alert(1)</script><b>');
    expect(html).toContain('<meta name="vivah-token" content="a&quot;&gt;&lt;/head&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;">');
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('<script type="module" src="/assets/app.js"></script>');
  });

  it("lists items, serves previews and the page, and rejects missing or wrong tokens", async () => {
    const { base, api } = await start(setup());
    const items = (await (await api("/api/items")).json()) as { items: { id: string; state: string; unsupported: string[] }[] };
    expect(items.items.map((i) => [i.id, i.state])).toEqual([["a.cr3", "review"], ["b.cr3", "review"]]);
    expect(items.items[0]!.unsupported).toEqual(["contrast"]);

    const img = await api("/api/preview/a.cr3");
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect((await img.arrayBuffer()).byteLength).toBe(4);
    expect((await api("/")).headers.get("content-type")).toContain("text/html");

    expect((await fetch(`${base.origin}/api/items`)).status).toBe(401);
    expect((await fetch(`${base.origin}/api/items?t=wrong`)).status).toBe(401);
    expect((await api("/api/preview/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
  });

  it("rejects requests whose Host header is not loopback (DNS rebinding)", async () => {
    const { base, token } = await start(setup());
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: base.port, path: `/api/items?t=${token}`, headers: { host: "evil.example.com" } }, (r) => resolve(r.statusCode ?? 0))
        .on("error", reject);
    });
    expect(status).toBe(403);
  });

  it("applies overrides to approved photos, leaves the rest in review, and nudges the profile", async () => {
    const s = setup();
    const { api } = await start(s);
    const res = await api("/api/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve: ["a.cr3"], overrides: { "a.cr3": recipe(1) } }),
    });
    expect(await res.json()).toMatchObject({ approved: 1, exported: 0, failed: 0, profileVersion: 2 });

    expect(s.applied).toEqual([{ id: "a.cr3", exposure: 1 }]);
    expect(s.store.listItems("j").map((i) => [i.assetId, i.state])).toEqual([["a.cr3", "approved"], ["b.cr3", "review"]]);
    expect(s.updates[0]!.baseAdjustments.exposure).toBeCloseTo(0.2);
  });

  it("runs the delivery step on every exported file and fails only the item that could not be finished", async () => {
    const s = setup();
    s.adapter.export = async (asset, spec) => ({ assetId: asset.id, file: `${spec.outputDir}/${asset.id}.jpg` });
    const finished: string[] = [];
    const { api } = await start(s, {
      exportSpec: { format: "jpeg", outputDir: "/out" },
      afterExport: async (file, asset) => {
        if (asset.id === "b.cr3") throw new Error("no space left");
        finished.push(file);
      },
    });
    const res = await api("/api/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve: ["a.cr3", "b.cr3"] }) });
    expect(await res.json()).toMatchObject({ exported: 1, failed: 1 });
    expect(finished).toEqual(["/out/a.cr3.jpg"]);
    expect(s.store.listItems("j").find((i) => i.assetId === "b.cr3")).toMatchObject({ state: "failed", errorCode: "EXPORT_FINISH_FAILED" });
  });

  it("refuses non-JSON writes, malformed bodies and out-of-range recipes", async () => {
    const s = setup();
    const { api } = await start(s);
    expect((await api("/api/decide", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await api("/api/decide", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" })).status).toBe(400);
    const bad = await api("/api/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve: ["a.cr3"], overrides: { "a.cr3": recipe(99) } }),
    });
    expect(bad.status).toBe(400);
    expect(s.applied).toEqual([]);
  });
});

const json = { "content-type": "application/json" };

describe("when the license no longer allows editing", () => {
  const decide = (api: Awaited<ReturnType<typeof start>>["api"], body: unknown) =>
    api("/api/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("says so in the listing, refuses an adjustment and changes nothing, but still approves photos as they are", async () => {
    const s = setup();
    const { api } = await start(s, { editingPaused: "subscription" });
    expect(((await (await api("/api/items")).json()) as { editing: unknown }).editing).toEqual({ allowed: false, reason: "subscription" });

    const refused = await decide(api, { approve: ["a.cr3"], overrides: { "a.cr3": recipe(1) } });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "EDITING_PAUSED", reason: "subscription" });
    expect(s.applied).toEqual([]);
    expect(s.updates).toEqual([]);
    expect(s.store.listItems("j").map((i) => i.state)).toEqual(["review", "review"]);

    const approved = await decide(api, { approve: ["a.cr3"], overrides: {} });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ approved: 1, failed: 0 });
    expect(s.store.listItems("j").map((i) => i.state)).toEqual(["approved", "review"]);
  });

  it("allows adjusting when nothing is paused", async () => {
    const { api } = await start(setup());
    expect(((await (await api("/api/items")).json()) as { editing: unknown }).editing).toEqual({ allowed: true });
    expect((await decide(api, { approve: ["a.cr3"], overrides: { "a.cr3": recipe(1) } })).status).toBe(200);
  });
});

describe("the page's own files", () => {
  it("serves its scripts, styles and translations without the token, and nothing else from disk", async () => {
    const { base } = await start(setup());
    const get = (path: string) => fetch(`${base.origin}${path}`);
    for (const [path, type] of [
      ["/assets/app.js", "text/javascript"], ["/assets/i18n.js", "text/javascript"], ["/assets/fields.js", "text/javascript"], ["/assets/filters.js", "text/javascript"],
      ["/assets/nav.js", "text/javascript"], ["/assets/dom.js", "text/javascript"], ["/assets/selection.js", "text/javascript"], ["/assets/picker.js", "text/javascript"],
      ["/assets/setup.js", "text/javascript"], ["/assets/app.css", "text/css"], ["/assets/locales/en.json", "application/json"], ["/assets/locales/hi.json", "application/json"],
    ] as const) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain(type);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(((await (await get("/assets/locales/hi.json")).json()) as Record<string, string>)["app.title"]).toContain("समीक्षा");
    for (const path of ["/assets/../server.ts", "/assets/..%2Fserver.ts", "/assets/app.js.map", "/assets/locales/fr.json", "/assets/", "/server.ts", "/client/app.js"]) {
      expect([401, 404], path).toContain((await get(path)).status);
    }
  });

  it("serves every script that the page's scripts import, so a new module cannot be forgotten", async () => {
    const { base } = await start(setup());
    const queue = ["/assets/app.js"];
    for (let i = 0; i < queue.length; i++) {
      const res = await fetch(`${base.origin}${queue[i]}`);
      expect(res.status, queue[i]).toBe(200);
      for (const m of (await res.text()).matchAll(/from\s*["'](\.\/[^"']+)["']/g)) {
        const next = new URL(m[1]!, `${base.origin}${queue[i]}`).pathname;
        if (!queue.includes(next)) queue.push(next);
      }
    }
    expect(queue.length).toBeGreaterThanOrEqual(8);
  });

  it("sends the page under a policy that allows only its own scripts and styles", async () => {
    const { api } = await start(setup());
    const csp = (await api("/")).headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("still refuses a rebound Host for the page's files", async () => {
    const { base } = await start(setup());
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: base.port, path: "/assets/app.js", headers: { host: "evil.example.com" } }, (r) => resolve(r.statusCode ?? 0)).on("error", reject);
    });
    expect(status).toBe(403);
  });
});

describe("drawing the edit", () => {
  const jpegBytes = (marker: number) => Buffer.from([0xff, 0xd8, 0xff, marker, 0xff, 0xd9]);
  const render = (api: (p: string, i?: RequestInit) => Promise<Response>, id: string, exposure: number) =>
    api(`/api/render/${id}`, { method: "POST", headers: json, body: JSON.stringify({ recipe: recipe(exposure) }) });

  it("draws the recipe it is sent onto the photo, and says so in the listing", async () => {
    const drawn: { id: string; exposure?: number }[] = [];
    const { api } = await start(setup(), {
      renderPreview: async (asset, r) => (drawn.push({ id: asset.id, exposure: r.adjustments.exposure }), { mediaType: "image/jpeg", dataBase64: jpegBytes(Math.round((r.adjustments.exposure ?? 0) * 10)).toString("base64") }),
    });
    expect(((await (await api("/api/items")).json()) as { rendering: boolean }).rendering).toBe(true);
    const res = await render(api, "a.cr3", 0.7);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(jpegBytes(7));
    expect(drawn).toEqual([{ id: "a.cr3", exposure: 0.7 }]);
  });

  it("reuses a drawing it has already made, and draws again for a different recipe or photo", async () => {
    let calls = 0;
    const { api } = await start(setup(), { renderPreview: async () => (calls++, { mediaType: "image/jpeg", dataBase64: jpegBytes(calls).toString("base64") }) });
    await render(api, "a.cr3", 0.5);
    await render(api, "a.cr3", 0.5);
    expect(calls).toBe(1);
    await render(api, "a.cr3", 0.6);
    await render(api, "b.cr3", 0.5);
    expect(calls).toBe(3);
  });

  it("draws one photo at a time and refuses a pile-up", async () => {
    let running = 0;
    let most = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { api } = await start(setup(), {
      renderPreview: async () => {
        running++;
        most = Math.max(most, running);
        await gate;
        running--;
        return { mediaType: "image/jpeg", dataBase64: jpegBytes(1).toString("base64") };
      },
    });
    const pending = Array.from({ length: 8 }, (_, i) => render(api, "a.cr3", i / 10));
    await new Promise((r) => setTimeout(r, 100));
    expect((await render(api, "a.cr3", 4)).status).toBe(429);
    release();
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(most).toBe(1);
  });

  it("refuses what it cannot draw: unknown photos, bad recipes, non-JSON, too much data, and a server with no renderer", async () => {
    const { api } = await start(setup(), { renderPreview: async () => ({ mediaType: "image/jpeg", dataBase64: jpegBytes(1).toString("base64") }) });
    expect((await render(api, "nope.cr3", 0)).status).toBe(404);
    expect((await render(api, "a.cr3", 99)).status).toBe(400);
    expect((await api("/api/render/a.cr3", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await api("/api/render/a.cr3", { method: "POST", headers: json, body: "{nope" })).status).toBe(400);
    expect((await api("/api/render/a.cr3", { method: "POST", headers: json, body: JSON.stringify({ recipe: recipe(0), padding: "x".repeat(200_000) }) })).status).toBe(400);
    await server?.close();
    const { api: plain } = await start(setup());
    expect((await render(plain, "a.cr3", 0)).status).toBe(404);
    expect(((await (await plain("/api/items")).json()) as { rendering: boolean }).rendering).toBe(false);
  });

  it("reports a failed drawing as an error, and tries again next time", async () => {
    let fail = true;
    const { api } = await start(setup(), { renderPreview: async () => { if (fail) throw new Error("cannot decode"); return { mediaType: "image/jpeg", dataBase64: jpegBytes(1).toString("base64") }; } });
    const failed = await render(api, "a.cr3", 0.1);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "cannot decode" });
    fail = false;
    expect((await render(api, "a.cr3", 0.1)).status).toBe(200);
  });
});

describe("restoring and flagging", () => {
  function withRejected() {
    const s = setup();
    s.store.putItem({ jobId: "j", assetId: "a.cr3", state: "rejected", rejectReason: "blurry", attempts: 0 });
    return s;
  }

  it("brings a set-aside photo back into the job and lists it as waiting for the next run", async () => {
    const s = withRejected();
    const { api } = await start(s, { library: s.store });
    const res = await api("/api/restore", { method: "POST", headers: json, body: JSON.stringify({ ids: ["a.cr3", "b.cr3", "ghost"] }) });
    expect(await res.json()).toEqual({ done: ["a.cr3"], skipped: [{ assetId: "b.cr3", reason: "it is review, not rejected" }, { assetId: "ghost", reason: "not part of this job" }] });
    const items = ((await (await api("/api/items")).json()) as { items: { id: string; state: string; restoredFrom?: string }[] }).items;
    expect(items.find((i) => i.id === "a.cr3")).toMatchObject({ state: "culled", restoredFrom: "blurry" });
    expect(s.store.listAudit({ jobId: "j" }).map((e) => e.action)).toEqual(["restore-rejected"]);
  });

  it("flags and unflags photos for retouching, with a note, and lists the queue", async () => {
    const s = setup();
    const { api } = await start(s);
    const post = (body: unknown) => api("/api/retouch", { method: "POST", headers: json, body: JSON.stringify(body) });
    expect(await (await post({ ids: ["b.cr3"], on: true, note: "remove the exit sign" })).json()).toEqual({ done: ["b.cr3"], skipped: [] });
    expect(await (await api("/api/retouch")).json()).toEqual({ items: [{ assetId: "b.cr3", state: "review", note: "remove the exit sign" }] });
    const listed = ((await (await api("/api/items")).json()) as { items: { id: string; retouch: boolean; retouchNote?: string }[] }).items;
    expect(listed.find((i) => i.id === "b.cr3")).toMatchObject({ retouch: true, retouchNote: "remove the exit sign" });
    await post({ ids: ["b.cr3"], on: false });
    expect(await (await api("/api/retouch")).json()).toEqual({ items: [] });
  });

  it("validates what it is sent and never accepts a write without JSON", async () => {
    const s = setup();
    const { api } = await start(s);
    for (const path of ["/api/restore", "/api/retouch"]) {
      expect((await api(path, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
      expect((await api(path, { method: "POST", headers: json, body: "{nope" })).status).toBe(400);
      expect((await api(path, { method: "POST", headers: json, body: JSON.stringify({ ids: "a.cr3", on: true }) })).status).toBe(400);
    }
    expect((await api("/api/retouch", { method: "POST", headers: json, body: JSON.stringify({ ids: ["a.cr3"], on: true, note: "x".repeat(501) }) })).status).toBe(400);
    expect((await api("/api/retouch", { method: "POST", headers: json, body: JSON.stringify({ ids: ["a.cr3"] }) })).status).toBe(400);
  });

  it("applies one change after another when several arrive together", async () => {
    const s = withRejected();
    const { api } = await start(s, { library: s.store });
    const calls = await Promise.all([
      api("/api/retouch", { method: "POST", headers: json, body: JSON.stringify({ ids: ["a.cr3"], on: true, note: "first" }) }),
      api("/api/restore", { method: "POST", headers: json, body: JSON.stringify({ ids: ["a.cr3"] }) }),
      api("/api/retouch", { method: "POST", headers: json, body: JSON.stringify({ ids: ["a.cr3"], on: true, note: "last" }) }),
    ]);
    expect(calls.map((c) => c.status)).toEqual([200, 200, 200]);
    expect(s.store.listItems("j").find((i) => i.assetId === "a.cr3")).toMatchObject({ state: "culled", retouch: true, retouchNote: "last", restoredFrom: "blurry" });
  });
});

describe("what has been sent", () => {
  const event = (over: Record<string, unknown> = {}) => ({ at: "2026-03-01T10:00:00Z", jobId: "j", provider: "openai", purpose: "recipe" as const, images: 3, imageBytes: 300_000, maxEdgePx: 2048, ...over });

  it("summarises the transfers recorded for this job, counting only what left the computer", async () => {
    const s = setup();
    s.store.recordOutbound(event());
    s.store.recordOutbound(event({ images: 2, imageBytes: 200_000, fullResolution: true }));
    s.store.recordOutbound(event({ provider: "ollama", local: true, images: 9, imageBytes: 9_000_000 }));
    s.store.recordOutbound(event({ jobId: "another-job", images: 50 }));
    const { api } = await start(s, { library: s.store });
    const body = (await (await api("/api/privacy")).json()) as { available: boolean; job: { totals: { images: number; imageBytes: number; fullResolutionCalls: number }; providers: { provider: string; local: boolean }[] } };
    expect(body.available).toBe(true);
    expect(body.job.totals).toMatchObject({ images: 5, imageBytes: 500_000, fullResolutionCalls: 1 });
    expect(body.job.providers.map((p) => [p.provider, p.local])).toEqual([["openai", false], ["ollama", true]]);
  });

  it("says when no record is kept", async () => {
    const { api } = await start(setup());
    expect(await (await api("/api/privacy")).json()).toEqual({ available: false });
  });

  it("needs the token like the rest of the API", async () => {
    const { base } = await start(setup());
    for (const path of ["/api/privacy", "/api/retouch", "/api/items"]) expect((await fetch(`${base.origin}${path}`)).status, path).toBe(401);
    for (const path of ["/api/restore", "/api/retouch", "/api/render/a.cr3", "/api/decide"]) expect((await fetch(`${base.origin}${path}`, { method: "POST", headers: json, body: "{}" })).status, path).toBe(401);
  });
});
