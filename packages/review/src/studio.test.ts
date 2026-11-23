import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, VivahError, type AssetRef, type EditorAdapter, type EditRecipe, type StyleProfile } from "@vivahlens/core";
import { startReviewServer, startStudioServer, type ReviewServer } from "./server.js";
import type { ReviewDeps } from "./session.js";
import { FieldError, type RunHooks, type StartRequest, type StudioWorkflow } from "./studio.js";

const recipe: EditRecipe = { version: "1.0", assetType: "photo", adjustments: { exposure: 0.5 } };
const assets: AssetRef[] = ["a.cr3", "b.cr3"].map((id) => ({ id, kind: "photo", path: `/shoot/${id}` }));
const profile: StyleProfile = { id: "p", name: "Warm", version: 1, summary: "", baseAdjustments: { exposure: 0 } };
const json = { "content-type": "application/json" };

const root = mkdtempSync(path.join(tmpdir(), "vivah-studio-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function jobDeps(over: Partial<ReviewDeps> = {}): ReviewDeps {
  const store = new MemoryStore();
  store.ensureJob({ id: "j", name: "j", adapterId: "fake", styleProfileId: "p", createdAt: "" });
  for (const a of assets) store.putItem({ jobId: "j", assetId: a.id, state: "review", recipe, attempts: 0 });
  const adapter: EditorAdapter = {
    id: "fake",
    capabilities: { mediaKinds: ["photo"], executionModel: "local-cli", requiresGuiOpen: false, os: ["windows"], supportedRecipeFields: ["exposure"] },
    detect: async () => ({}),
    applyRecipe: async (asset) => ({ assetId: asset.id, outputs: [] }),
  };
  return { store, jobId: "j", assets, adapter, profile, previewOf: async () => ({ mediaType: "image/jpeg", dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") }), ...over };
}

/** A workflow that does what the real one does in outline, under the test's control. */
function workflow(over: Partial<StudioWorkflow> = {}) {
  const started: StartRequest[] = [];
  const disposed: string[] = [];
  let release: () => void = () => undefined;
  let gate: Promise<void> = Promise.resolve();
  const hold = () => (gate = new Promise<void>((resolve) => (release = resolve)));
  const wf: StudioWorkflow = {
    setup: { defaults: { provider: "mock" }, providers: [{ id: "mock", needsModel: false, local: true }, { id: "openai", needsModel: true, local: false }], outputUsed: true, maxReferences: 10 },
    countPhotos: async (folder) => (path.basename(folder).startsWith("photos") ? 3 : 0),
    validate: async (request) => {
      if (request.input.endsWith("missing")) throw new FieldError("input", "That folder was not found.");
    },
    start: async (request, hooks: RunHooks) => {
      started.push(request);
      hooks.progress({ stage: "queued", done: 1, total: 3 });
      hooks.log("Reading files");
      await new Promise<void>((resolve, reject) => {
        hooks.signal.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { name: "AbortError" })), { once: true });
        gate.then(resolve);
      });
      return jobDeps({ dispose: async () => void disposed.push(request.input) });
    },
    ...over,
  };
  return { wf, started, disposed, hold, release: () => release() };
}

let server: ReviewServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function open(wf: StudioWorkflow | undefined, initial?: ReviewDeps) {
  server = initial ? await startReviewServer(initial, wf ? { workflow: wf } : {}) : await startStudioServer(wf!);
  const base = new URL(server.url);
  const token = base.searchParams.get("t")!;
  const api = (route: string, init?: RequestInit) => fetch(`${base.origin}${route}${route.includes("?") ? "&" : "?"}t=${token}`, init);
  const post = (route: string, body: unknown = {}) => api(route, { method: "POST", headers: json, body: JSON.stringify(body) });
  const workspace = async () => (await (await api("/api/workspace")).json()) as { phase: string; canStart: boolean; run?: { stage: string; done: number; total: number; log: string[]; stopping: boolean }; failure?: { message: string; code?: string }; stopped?: boolean; setup?: { defaults: StartRequest } };
  const until = (phase: string) => vi.waitFor(async () => expect((await workspace()).phase).toBe(phase), { timeout: 5000 });
  return { base, token, api, post, workspace, until };
}

const request = { input: path.join(root, "photos-in"), output: path.join(root, "out"), profile: path.join(root, "photos-style") };

describe("choosing folders and starting an edit", () => {
  it("opens on the setup page with nothing to review, and says what it offers", async () => {
    const { wf } = workflow();
    const { workspace, api } = await open(wf);
    const ws = await workspace();
    expect(ws).toMatchObject({ phase: "setup", canStart: true, setup: { outputUsed: true, maxReferences: 10, defaults: { provider: "mock" } } });
    expect(ws.setup).toMatchObject({ providers: [{ id: "mock", local: true }, { id: "openai", needsModel: true }] });
    for (const route of ["/api/items", "/api/privacy", "/api/retouch", "/api/preview/a.cr3"]) {
      const res = await api(route);
      expect(res.status, route).toBe(409);
      expect(await res.json()).toMatchObject({ code: "NO_SESSION" });
    }
  });

  it("runs the edit in the background, shows its progress, then opens the photos for review", async () => {
    const t = workflow();
    t.hold();
    const { workspace, post, api, until } = await open(t.wf);

    const started = await post("/api/start", { ...request, provider: "mock" });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ phase: "running" });
    await vi.waitFor(async () => expect((await workspace()).run).toMatchObject({ stage: "queued", done: 1, total: 3, log: ["Reading files"], stopping: false }));
    expect(t.started).toEqual([{ ...request, provider: "mock" }]);

    t.release();
    await until("review");
    const items = (await (await api("/api/items")).json()) as { items: { id: string; state: string }[] };
    expect(items.items.map((i) => [i.id, i.state])).toEqual([["a.cr3", "review"], ["b.cr3", "review"]]);
    expect((await workspace()).run).toBeUndefined();
  });

  it("remembers what was chosen, so starting another shoot begins from it", async () => {
    const t = workflow();
    const { post, workspace, until } = await open(t.wf);
    await post("/api/start", { ...request, provider: "openai", model: "some-model" });
    await until("review");
    expect((await workspace()).setup?.defaults).toMatchObject({ ...request, provider: "openai", model: "some-model" });
  });

  it("refuses a request that cannot work, naming what to fix, and starts nothing", async () => {
    const t = workflow();
    const { post, workspace } = await open(t.wf);
    const res = await post("/api/start", { ...request, input: path.join(root, "missing") });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That folder was not found.", field: "input" });
    expect(t.started).toEqual([]);
    expect((await workspace()).phase).toBe("setup");
  });

  it("refuses malformed requests and writes that are not JSON", async () => {
    const { wf } = workflow();
    const { post, api } = await open(wf);
    expect((await post("/api/start", { input: "x" })).status).toBe(400);
    expect((await post("/api/start", { ...request, extra: 1 })).status).toBe(400);
    expect((await post("/api/start", { ...request, input: "" })).status).toBe(400);
    expect((await post("/api/start", { ...request, input: "x".repeat(5000) })).status).toBe(400);
    for (const route of ["/api/start", "/api/cancel", "/api/reset", "/api/folders"]) {
      expect((await api(route, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, route).toBe(415);
      expect((await api(route, { method: "POST", headers: json, body: "{nope" })).status, route).toBe(400);
    }
  });

  it("does not start a second edit while one is running or photos are open", async () => {
    const t = workflow();
    t.hold();
    const { post, until } = await open(t.wf);
    expect((await post("/api/start", request)).status).toBe(202);
    const busy = await post("/api/start", request);
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toContain("already running");
    expect((await post("/api/reset")).status).toBe(409);
    t.release();
    await until("review");
    expect((await post("/api/start", request)).status).toBe(409);
    expect(t.started).toHaveLength(1);
  });

  it("starts only one of two requests that arrive together", async () => {
    const t = workflow({ validate: async () => new Promise((r) => setTimeout(r, 30)) });
    const { post } = await open(t.wf);
    const answers = await Promise.all([post("/api/start", request), post("/api/start", request)]);
    expect(answers.map((a) => a.status).sort()).toEqual([202, 409]);
    expect(t.started).toHaveLength(1);
  });
});

describe("when an edit does not finish", () => {
  it("goes back to the setup page with the reason, and lets the person try again", async () => {
    let attempt = 0;
    const t = workflow({
      start: async () => {
        if (attempt++ === 0) throw new VivahError("LLM_AUTH", "OPENAI_API_KEY is not set");
        return jobDeps();
      },
    });
    const { post, workspace, until } = await open(t.wf);
    await post("/api/start", { ...request, provider: "openai", model: "m" });
    await vi.waitFor(async () => expect((await workspace()).failure).toEqual({ message: "OPENAI_API_KEY is not set", code: "LLM_AUTH" }));
    expect((await workspace()).phase).toBe("setup");

    expect((await post("/api/start", request)).status).toBe(202);
    await until("review");
    expect((await workspace()).failure).toBeUndefined();
  });

  it("stops when asked, keeps no failure, and says it was stopped", async () => {
    const t = workflow();
    t.hold();
    const { post, workspace, until } = await open(t.wf);
    await post("/api/start", request);
    const stopping = (await (await post("/api/cancel")).json()) as { run?: { stopping: boolean } };
    expect(stopping.run?.stopping).toBe(true);
    await until("setup");
    expect(await workspace()).toMatchObject({ stopped: true });
    expect((await workspace()).failure).toBeUndefined();
  });

  it("drops photos that finished opening just after the stop, rather than showing them", async () => {
    const t = workflow({
      start: async (req, hooks) => {
        await new Promise((resolve) => hooks.signal.addEventListener("abort", resolve, { once: true }));
        return jobDeps({ dispose: async () => void disposedLate.push(req.input) });
      },
    });
    const disposedLate: string[] = [];
    const { post, workspace, until } = await open(t.wf);
    await post("/api/start", request);
    await post("/api/cancel");
    await until("setup");
    expect(disposedLate).toEqual([request.input]);
    expect((await workspace()).stopped).toBe(true);
  });

  it("answers a stop with nothing running as nothing to do", async () => {
    const { wf } = workflow();
    const { post } = await open(wf);
    const res = await post("/api/cancel");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ phase: "setup" });
  });
});

describe("starting another shoot", () => {
  it("frees the open photos and returns to the setup page", async () => {
    const t = workflow();
    const { post, until, api } = await open(t.wf);
    await post("/api/start", request);
    await until("review");
    const res = await post("/api/reset");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ phase: "setup" });
    expect(t.disposed).toEqual([request.input]);
    expect((await api("/api/items")).status).toBe(409);
  });

  it("can start from a job that was opened directly, when a workflow is attached", async () => {
    const t = workflow();
    const closed: string[] = [];
    const { workspace, post, until } = await open(t.wf, jobDeps({ dispose: async () => void closed.push("first") }));
    expect(await workspace()).toMatchObject({ phase: "review", canStart: true });
    await post("/api/reset");
    expect(closed).toEqual(["first"]);
    await post("/api/start", request);
    await until("review");
  });

  it("cannot go back when the page was opened on one finished job with no way to choose folders", async () => {
    const { workspace, post } = await open(undefined, jobDeps());
    expect(await workspace()).toEqual({ phase: "review", canStart: false });
    expect((await post("/api/reset")).status).toBe(409);
    expect((await post("/api/start", request)).status).toBe(409);
  });
});

describe("closing the server", () => {
  it("stops a running edit and waits for it, then frees what it held", async () => {
    const seen: string[] = [];
    const t = workflow({
      start: async (_req, hooks) => {
        await new Promise((resolve) => hooks.signal.addEventListener("abort", resolve, { once: true }));
        seen.push("aborted");
        return jobDeps({ dispose: async () => void seen.push("disposed") });
      },
    });
    const { post } = await open(t.wf);
    await post("/api/start", request);
    await server?.close();
    server = undefined;
    expect(seen).toEqual(["aborted", "disposed"]);
  });

  it("frees the open photos", async () => {
    const closed: string[] = [];
    await open(workflow().wf, jobDeps({ dispose: async () => void closed.push("closed") }));
    await server?.close();
    server = undefined;
    expect(closed).toEqual(["closed"]);
  });
});

describe("the folder chooser", () => {
  it("lists folders with the number of photos directly inside, and needs the token", async () => {
    mkdirSync(path.join(root, "browse", "photos-a"), { recursive: true });
    mkdirSync(path.join(root, "browse", "other"), { recursive: true });
    const { wf } = workflow();
    const { api, base } = await open(wf);
    const listing = (await (await api(`/api/browse?path=${encodeURIComponent(path.join(root, "browse"))}`)).json()) as { path: string; photos: number; folders: { name: string }[] };
    expect(listing.folders.map((f) => f.name)).toEqual(["other", "photos-a"]);
    expect(listing.photos).toBe(0);
    expect(((await (await api(`/api/browse?path=${encodeURIComponent(path.join(root, "browse", "photos-a"))}`)).json()) as { photos: number }).photos).toBe(3);
    expect((await fetch(`${base.origin}/api/browse?path=${encodeURIComponent(root)}`)).status).toBe(401);
    expect((await fetch(`${base.origin}/api/places`)).status).toBe(401);
  });

  it("opens somewhere sensible when no folder is named, and lists places to start from", async () => {
    const { wf } = workflow();
    const { api } = await open(wf);
    const start = (await (await api("/api/browse")).json()) as { path: string; parent: string | null };
    expect(path.isAbsolute(start.path)).toBe(true);
    const found = (await (await api("/api/places")).json()) as { roots: { path: string }[]; shortcuts: { kind: string }[] };
    expect(found.roots.length).toBeGreaterThan(0);
    expect(found.shortcuts.some((s) => s.kind === "home")).toBe(true);
  });

  it("says what is wrong with a folder the person typed, with a status for each kind of problem", async () => {
    const { wf } = workflow();
    const { api } = await open(wf);
    const ask = async (folder: string) => {
      const res = await api(`/api/browse?path=${encodeURIComponent(folder)}`);
      return [res.status, ((await res.json()) as { code?: string }).code];
    };
    expect(await ask("not/absolute")).toEqual([400, "RELATIVE"]);
    expect(await ask(path.join(root, "never-made"))).toEqual([404, "MISSING"]);
  });

  it("makes a new folder for the output, and refuses a name that cannot be used", async () => {
    mkdirSync(path.join(root, "mk-route"), { recursive: true });
    const { wf } = workflow();
    const { post } = await open(wf);
    const made = await post("/api/folders", { parent: path.join(root, "mk-route"), name: "Edited" });
    expect(made.status).toBe(201);
    expect(await made.json()).toEqual({ name: "Edited", path: path.join(root, "mk-route", "Edited") });
    expect((await post("/api/folders", { parent: path.join(root, "mk-route"), name: "Edited" })).status).toBe(409);
    expect((await post("/api/folders", { parent: path.join(root, "mk-route"), name: "a/b" })).status).toBe(400);
    expect((await post("/api/folders", { parent: path.join(root, "mk-route") })).status).toBe(400);
  });

  it("answers whether a typed path is a folder with a normal reply either way, so checking as someone types logs no errors", async () => {
    mkdirSync(path.join(root, "check-route", "photos-here"), { recursive: true });
    const { api, base } = await open(workflow().wf);
    const ask = async (folder: string) => {
      const res = await api(`/api/folder?path=${encodeURIComponent(folder)}`);
      return [res.status, await res.json()];
    };
    expect(await ask(path.join(root, "check-route", "photos-here"))).toEqual([200, { ok: true, path: path.join(root, "check-route", "photos-here"), photos: 3 }]);
    expect(await ask(path.join(root, "check-route"))).toEqual([200, { ok: true, path: path.join(root, "check-route"), photos: 0 }]);
    expect(await ask(path.join(root, "check-route", "not-yet"))).toEqual([200, { ok: false, code: "MISSING", error: expect.stringContaining("was not found") }]);
    expect(await ask("relative")).toEqual([200, { ok: false, code: "RELATIVE", error: expect.any(String) }]);
    expect(await ask("")).toEqual([200, { ok: false, code: "RELATIVE", error: expect.any(String) }]);
    expect((await fetch(`${base.origin}/api/folder?path=${encodeURIComponent(root)}`)).status).toBe(401);
  });

  it("lists nothing about files and answers 0 photos when there is no workflow to count them", async () => {
    mkdirSync(path.join(root, "plain"), { recursive: true });
    const { api } = await open(undefined, jobDeps());
    const body = (await (await api(`/api/browse?path=${encodeURIComponent(path.join(root, "plain"))}`)).json()) as Record<string, unknown>;
    expect(body.photos).toBe(0);
    expect(Object.keys(body).sort()).toEqual(["folders", "parent", "path", "photos", "truncated"]);
  });
});
