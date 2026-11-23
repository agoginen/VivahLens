import { timingSafeEqual, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { boundedArray, EditRecipeSchema, embeddedAsset, retouchQueue } from "@vivahlens/core";
import { BrowseError, checkFolder, createFolder, listFolder, places, startFolder, type BrowseCode } from "./browse.js";
import { RenderQueueFull, type ReviewDeps, type ReviewSession } from "./session.js";
import { FieldError, Studio, StudioConflict, type StudioWorkflow } from "./studio.js";
import { reviewPage } from "./ui.js";

export interface ReviewServer {
  /** URL including the one-time token. */
  url: string;
  close(): Promise<void>;
}

const DecisionSchema = z.object({
  approve: z.array(z.string()),
  overrides: z.record(EditRecipeSchema).default({}),
});
const IdsSchema = z.object({ ids: boundedArray(z.string(), 5000) });
const RetouchSchema = IdsSchema.extend({ on: z.boolean(), note: z.string().max(500).optional() });
const RenderSchema = z.object({ recipe: EditRecipeSchema });
const FolderPath = z.string().min(1).max(4096);
const StartSchema = z
  .object({ input: FolderPath, output: FolderPath.optional(), profile: FolderPath, provider: z.string().max(40).optional(), model: z.string().max(200).optional() })
  .strict();
const NewFolderSchema = z.object({ parent: FolderPath, name: z.string().min(1).max(200) }).strict();

const MAX_BODY_BYTES = 1_000_000;
const MAX_RENDER_BODY_BYTES = 100_000;
const MAX_SMALL_BODY_BYTES = 20_000;

const BROWSE_STATUS: Record<BrowseCode, number> = { RELATIVE: 400, MISSING: 404, NOT_A_FOLDER: 400, DENIED: 403, BAD_NAME: 400, EXISTS: 409, FAILED: 500 };

const CLIENT_DIR = new URL("./client/", import.meta.url);
/** The page's own files: embedded in the single-file build, otherwise next to this module. */
const readClientFile = async (file: string): Promise<Buffer> => embeddedAsset(`review/client/${file}`) ?? fs.readFile(new URL(file, CLIENT_DIR));
/** The only files the server hands out besides the page and its API: the page's own scripts, styles and translations. */
const ASSETS: Record<string, { file: string; type: string }> = {
  "/assets/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/assets/dom.js": { file: "dom.js", type: "text/javascript; charset=utf-8" },
  "/assets/i18n.js": { file: "i18n.js", type: "text/javascript; charset=utf-8" },
  "/assets/fields.js": { file: "fields.js", type: "text/javascript; charset=utf-8" },
  "/assets/filters.js": { file: "filters.js", type: "text/javascript; charset=utf-8" },
  "/assets/nav.js": { file: "nav.js", type: "text/javascript; charset=utf-8" },
  "/assets/selection.js": { file: "selection.js", type: "text/javascript; charset=utf-8" },
  "/assets/picker.js": { file: "picker.js", type: "text/javascript; charset=utf-8" },
  "/assets/setup.js": { file: "setup.js", type: "text/javascript; charset=utf-8" },
  "/assets/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/assets/locales/en.json": { file: "locales/en.json", type: "application/json; charset=utf-8" },
  "/assets/locales/hi.json": { file: "locales/hi.json", type: "application/json; charset=utf-8" },
};

/** No job is open for review yet, so a route that needs one has nothing to answer with. */
class NoSession extends Error {}

/**
 * Local-only review UI (plan §4): choose the photo folders and start an edit, then before/after, per-photo sliders that map
 * to recipe fields, approve, retouch flags (one photo or many), bringing back photos the cull set aside, and what has been
 * sent to a model. Security: binds to 127.0.0.1, requires an unguessable token for the page and its API, validates Host
 * (DNS rebinding) and requires a JSON content type on writes (cross-site form posts cannot send one). The page loads only
 * its own scripts (no inline script). The folder chooser lists folder names only, never files.
 */
export async function startReviewServer(deps: ReviewDeps, opts: { port?: number; workflow?: StudioWorkflow } = {}): Promise<ReviewServer> {
  return serve(new Studio(opts.workflow, deps), opts.port);
}

/** The same page, starting at the choice of folders: nothing is open for review until an edit has run. */
export async function startStudioServer(workflow: StudioWorkflow, opts: { port?: number } = {}): Promise<ReviewServer> {
  return serve(new Studio(workflow), opts.port);
}

async function serve(studio: Studio, wantedPort: number | undefined): Promise<ReviewServer> {
  const token = randomBytes(24).toString("base64url");
  const assetFiles = new Map<string, Promise<Buffer>>();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => fail(res, err));
  });

  const session = (): ReviewSession => {
    const open = studio.current;
    if (!open) throw new NoSession();
    return open;
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const port = (server.address() as AddressInfo).port;
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: "bad host" });

    const url = new URL(req.url ?? "/", `http://${host}`);
    const asset = req.method === "GET" ? ASSETS[url.pathname] : undefined;
    if (asset) return sendAsset(res, asset);
    if (!tokenOk(url.searchParams.get("t") ?? "", token)) return send(res, 401, { error: "unauthorized" });

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      res.end(reviewPage(token));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace") return send(res, 200, studio.snapshot());
    if (req.method === "GET" && url.pathname === "/api/places") return send(res, 200, await places());
    if (req.method === "GET" && url.pathname === "/api/folder") {
      // Always 200: a folder that is missing is an ordinary answer to "is this a folder?", not a failed request.
      try {
        const folder = await checkFolder(url.searchParams.get("path") ?? "");
        return send(res, 200, { ok: true, path: folder, photos: await studio.countPhotos(folder) });
      } catch (err) {
        if (err instanceof BrowseError) return send(res, 200, { ok: false, code: err.code, error: err.message });
        throw err;
      }
    }
    if (req.method === "GET" && url.pathname === "/api/browse") {
      const wanted = url.searchParams.get("path");
      const folder = await listFolder(wanted ? wanted : await startFolder());
      return send(res, 200, { ...folder, photos: await studio.countPhotos(folder.path) });
    }
    if (req.method === "POST" && ["/api/start", "/api/cancel", "/api/reset", "/api/folders"].includes(url.pathname)) return control(req, res, url.pathname);

    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, session().listing());
    if (req.method === "GET" && url.pathname === "/api/privacy") return send(res, 200, session().privacy());
    if (req.method === "GET" && url.pathname === "/api/retouch") {
      const { deps } = session();
      return send(res, 200, { items: retouchQueue(deps.store, deps.jobId) });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/preview/")) {
      const bytes = await session().preview(decodeURIComponent(url.pathname.slice("/api/preview/".length)));
      if (!bytes) return send(res, 404, { error: "unknown asset" });
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=300" });
      res.end(bytes);
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/render/")) return renderRoute(req, res, decodeURIComponent(url.pathname.slice("/api/render/".length)));
    if (req.method === "POST" && ["/api/decide", "/api/restore", "/api/retouch"].includes(url.pathname)) {
      const open = session();
      const read = await readJson(req, res, MAX_BODY_BYTES);
      if (!read) return;
      if (url.pathname === "/api/decide") {
        const parsed = DecisionSchema.safeParse(read.body);
        if (!parsed.success) return send(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid decision" });
        const { deps } = open;
        if (deps.editingPaused && Object.keys(parsed.data.overrides).length > 0) {
          deps.logger?.warn("review.adjustment-refused", { jobId: deps.jobId, reason: deps.editingPaused, photos: Object.keys(parsed.data.overrides).length });
          return send(res, 403, { error: "Editing is paused: the license needs renewing. Approving and exporting still work.", code: "EDITING_PAUSED", reason: deps.editingPaused });
        }
        return send(res, 200, await open.serialized(() => open.decide(parsed.data)));
      }
      if (url.pathname === "/api/restore") {
        const parsed = IdsSchema.safeParse(read.body);
        if (!parsed.success) return send(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid request" });
        return send(res, 200, await open.restore(parsed.data.ids));
      }
      const parsed = RetouchSchema.safeParse(read.body);
      if (!parsed.success) return send(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid request" });
      return send(res, 200, await open.flag(parsed.data.ids, parsed.data.on, parsed.data.note));
    }
    send(res, 404, { error: "not found" });
  }

  /** Choosing folders and starting, stopping or leaving an edit. */
  async function control(req: http.IncomingMessage, res: http.ServerResponse, route: string): Promise<void> {
    const read = await readJson(req, res, MAX_SMALL_BODY_BYTES);
    if (!read) return;
    if (route === "/api/cancel") {
      studio.cancel();
      return send(res, 200, studio.snapshot());
    }
    if (route === "/api/reset") {
      await studio.reset();
      return send(res, 200, studio.snapshot());
    }
    if (route === "/api/folders") {
      const parsed = NewFolderSchema.safeParse(read.body);
      if (!parsed.success) return send(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid request" });
      return send(res, 201, await createFolder(parsed.data.parent, parsed.data.name));
    }
    const parsed = StartSchema.safeParse(read.body);
    if (!parsed.success) return send(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid request" });
    await studio.start(parsed.data);
    send(res, 202, studio.snapshot());
  }

  function sendAsset(res: http.ServerResponse, asset: { file: string; type: string }): void {
    if (!assetFiles.has(asset.file)) assetFiles.set(asset.file, readClientFile(asset.file));
    assetFiles
      .get(asset.file)!
      .then((bytes) => {
        res.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
        res.end(bytes);
      })
      .catch(() => {
        assetFiles.delete(asset.file);
        send(res, 500, { error: "asset unavailable" });
      });
  }

  async function renderRoute(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const open = session();
    if (!open.canRender) return send(res, 404, { error: "rendering is not available" });
    if (!String(req.headers["content-type"]).startsWith("application/json")) return send(res, 415, { error: "json required" });
    if (!open.has(id)) return send(res, 404, { error: "unknown asset" });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, MAX_RENDER_BODY_BYTES));
    } catch {
      return send(res, 400, { error: "invalid JSON" });
    }
    const parsed = RenderSchema.safeParse(body);
    if (!parsed.success) return send(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid recipe" });
    try {
      const image = await open.render(id, parsed.data.recipe);
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=300" });
      res.end(image);
    } catch (err) {
      if (err instanceof RenderQueueFull) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      send(res, 500, { error: err instanceof Error ? err.message : "could not draw the edit" });
    }
  }

  await new Promise<void>((resolve) => server.listen(wantedPort ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    close: async () => {
      await new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve())));
      await studio.close();
    },
  };
}

function fail(res: http.ServerResponse, err: unknown): void {
  if (err instanceof FieldError) return send(res, 400, { error: err.message, field: err.field });
  if (err instanceof StudioConflict) return send(res, 409, { error: err.message, code: "CONFLICT" });
  if (err instanceof BrowseError) return send(res, BROWSE_STATUS[err.code], { error: err.message, code: err.code });
  if (err instanceof NoSession) return send(res, 409, { error: "No photos are open yet.", code: "NO_SESSION" });
  send(res, 500, { error: err instanceof Error ? err.message : "internal error" });
}

function tokenOk(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** A JSON body, or undefined after answering 415 (not JSON) or 400 (unreadable, or larger than `limit`). */
async function readJson(req: http.IncomingMessage, res: http.ServerResponse, limit: number): Promise<{ body: unknown } | undefined> {
  if (!String(req.headers["content-type"]).startsWith("application/json")) {
    send(res, 415, { error: "json required" });
    return undefined;
  }
  try {
    return { body: JSON.parse(await readBody(req, limit)) };
  } catch {
    send(res, 400, { error: "invalid JSON" });
    return undefined;
  }
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
