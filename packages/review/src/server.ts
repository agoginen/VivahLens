import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import {
  boundedArray,
  diffOverrides,
  embeddedAsset,
  EditRecipeSchema,
  exportApproved,
  learnFromOverrides,
  restoreRejected,
  retouchQueue,
  setRetouch,
  summarizeOutbound,
  unsupportedFields,
  type AssetRef,
  type EditorAdapter,
  type EditRecipe,
  type ExportSpec,
  type ItemState,
  type JobStore,
  type LibraryStore,
  type Logger,
  type Preview,
  type StageDeps,
  type StyleProfile,
} from "@vivahlens/core";
import { reviewPage } from "./ui.js";

export interface ReviewDeps {
  store: JobStore;
  /** Records reviewer corrections and the audit trail, and supplies the record of what was sent to models, when provided. */
  library?: LibraryStore;
  jobId: string;
  assets: readonly AssetRef[];
  adapter: EditorAdapter;
  profile: StyleProfile;
  /** Smaller previews than the LLM gets are fine here; callers usually pass a ~1024px loader. */
  previewOf(asset: AssetRef): Promise<Preview>;
  /**
   * Draws a recipe onto a photo for the "with the edit" view. Without it the page approximates exposure, contrast and
   * saturation in the browser instead.
   */
  renderPreview?(asset: AssetRef, recipe: EditRecipe): Promise<Preview>;
  /** Required when the adapter can export. */
  exportSpec?: ExportSpec;
  /** Delivery step run on every exported file (see `StageDeps.afterExport`). */
  afterExport?: StageDeps["afterExport"];
  /** Called with the profile after reviewer overrides have nudged it. */
  onProfileUpdated?(profile: StyleProfile): void | Promise<void>;
  /**
   * Set when the license no longer allows editing (the reason is shown in the page, translated). Adjusting a photo is
   * refused; approving, retouch flags and exporting still work, so finished work can always be taken out.
   */
  editingPaused?: "expired" | "subscription" | "device";
  /** Structured log of what the reviewer does (plan §7.6); the decisions are logged by the export step itself. */
  logger?: Logger;
}

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

const MAX_BODY_BYTES = 1_000_000;
const MAX_RENDER_BODY_BYTES = 100_000;
const RENDER_CACHE = 48;
const MAX_QUEUED_RENDERS = 8;

const CLIENT_DIR = new URL("./client/", import.meta.url);
/** The page's own files: embedded in the single-file build, otherwise next to this module. */
const readClientFile = async (file: string): Promise<Buffer> => embeddedAsset(`review/client/${file}`) ?? fs.readFile(new URL(file, CLIENT_DIR));
/** The only files the server hands out besides the page and its API: the page's own scripts, styles and translations. */
const ASSETS: Record<string, { file: string; type: string }> = {
  "/assets/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/assets/i18n.js": { file: "i18n.js", type: "text/javascript; charset=utf-8" },
  "/assets/fields.js": { file: "fields.js", type: "text/javascript; charset=utf-8" },
  "/assets/filters.js": { file: "filters.js", type: "text/javascript; charset=utf-8" },
  "/assets/nav.js": { file: "nav.js", type: "text/javascript; charset=utf-8" },
  "/assets/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/assets/locales/en.json": { file: "locales/en.json", type: "application/json; charset=utf-8" },
  "/assets/locales/hi.json": { file: "locales/hi.json", type: "application/json; charset=utf-8" },
};

/**
 * Local-only review UI (plan §4): before/after, per-photo sliders that map to recipe fields, approve, retouch flags,
 * bringing back photos the cull set aside, and what has been sent to a model. Security: binds to 127.0.0.1, requires an
 * unguessable token for the page and its API, validates Host (DNS rebinding) and requires a JSON content type on writes
 * (cross-site form posts cannot send one). The page loads only its own scripts (no inline script).
 */
export async function startReviewServer(deps: ReviewDeps, opts: { port?: number } = {}): Promise<ReviewServer> {
  const token = randomBytes(24).toString("base64url");
  const previews = new Map<string, Promise<Buffer>>();
  const renders = new Map<string, Promise<Buffer>>();
  const assetFiles = new Map<string, Promise<Buffer>>();
  const assetsById = new Map(deps.assets.map((a) => [a.id, a]));
  let profile = deps.profile;
  let queue: Promise<unknown> = Promise.resolve();
  let queuedRenders = 0;
  let renderChain: Promise<unknown> = Promise.resolve();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { error: err instanceof Error ? err.message : "internal error" }));
  });

  /** Runs a change to the job's items after the one before it has finished, so two clicks never interleave. */
  const serialized = <T>(work: () => Promise<T> | T): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
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
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, listing());
    if (req.method === "GET" && url.pathname === "/api/privacy") return send(res, 200, privacy());
    if (req.method === "GET" && url.pathname === "/api/retouch") return send(res, 200, { items: retouchQueue(deps.store, deps.jobId) });
    if (req.method === "GET" && url.pathname.startsWith("/api/preview/")) {
      const asset = assetsById.get(decodeURIComponent(url.pathname.slice("/api/preview/".length)));
      if (!asset) return send(res, 404, { error: "unknown asset" });
      if (!previews.has(asset.id)) previews.set(asset.id, deps.previewOf(asset).then((p) => Buffer.from(p.dataBase64, "base64")));
      const bytes = await previews.get(asset.id)!;
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=300" });
      res.end(bytes);
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/render/")) return renderRoute(req, res, decodeURIComponent(url.pathname.slice("/api/render/".length)));
    if (req.method === "POST" && ["/api/decide", "/api/restore", "/api/retouch"].includes(url.pathname)) {
      if (!String(req.headers["content-type"]).startsWith("application/json")) return send(res, 415, { error: "json required" });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req, MAX_BODY_BYTES));
      } catch {
        return send(res, 400, { error: "invalid JSON" });
      }
      if (url.pathname === "/api/decide") {
        const parsed = DecisionSchema.safeParse(body);
        if (!parsed.success) return send(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid decision" });
        if (deps.editingPaused && Object.keys(parsed.data.overrides).length > 0) {
          deps.logger?.warn("review.adjustment-refused", { jobId: deps.jobId, reason: deps.editingPaused, photos: Object.keys(parsed.data.overrides).length });
          return send(res, 403, { error: "Editing is paused: the license needs renewing. Approving and exporting still work.", code: "EDITING_PAUSED", reason: deps.editingPaused });
        }
        return send(res, 200, await serialized(() => decide(parsed.data)));
      }
      if (url.pathname === "/api/restore") {
        const parsed = IdsSchema.safeParse(body);
        if (!parsed.success) return send(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid request" });
        return send(res, 200, await serialized(() => restoreRejected({ store: deps.store, ...(deps.library && { library: deps.library }) }, deps.jobId, parsed.data.ids)));
      }
      const parsed = RetouchSchema.safeParse(body);
      if (!parsed.success) return send(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid request" });
      return send(res, 200, await serialized(() => setRetouch({ store: deps.store, ...(deps.library && { library: deps.library }) }, deps.jobId, parsed.data.ids, parsed.data.on, parsed.data.note)));
    }
    send(res, 404, { error: "not found" });
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

  /** Draws the recipe the reviewer is trying onto the photo. Renders are CPU-bound, so they run one at a time and a pile-up is refused. */
  async function renderRoute(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    if (!deps.renderPreview) return send(res, 404, { error: "rendering is not available" });
    if (!String(req.headers["content-type"]).startsWith("application/json")) return send(res, 415, { error: "json required" });
    const asset = assetsById.get(id);
    if (!asset) return send(res, 404, { error: "unknown asset" });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, MAX_RENDER_BODY_BYTES));
    } catch {
      return send(res, 400, { error: "invalid JSON" });
    }
    const parsed = RenderSchema.safeParse(body);
    if (!parsed.success) return send(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid recipe" });

    const key = createHash("sha256").update(id).update("\0").update(JSON.stringify(parsed.data.recipe)).digest("hex");
    let bytes = renders.get(key);
    if (!bytes) {
      if (queuedRenders >= MAX_QUEUED_RENDERS) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "too many renders waiting" }));
        return;
      }
      queuedRenders++;
      const work = renderChain.then(() => deps.renderPreview!(asset, parsed.data.recipe)).then((p) => Buffer.from(p.dataBase64, "base64"));
      renderChain = work.catch(() => undefined);
      bytes = work.finally(() => void queuedRenders--);
      renders.set(key, bytes);
      bytes.catch(() => renders.delete(key));
      while (renders.size > RENDER_CACHE) renders.delete(renders.keys().next().value!);
    }
    try {
      const image = await bytes;
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=300" });
      res.end(image);
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : "could not draw the edit" });
    }
  }

  function privacy() {
    if (!deps.library) return { available: false };
    return { available: true, job: summarizeOutbound(deps.library.listOutbound({ jobId: deps.jobId })) };
  }

  function listing() {
    const order: Record<ItemState, number> = {
      review: 0,
      failed: 1,
      approved: 2,
      exported: 2,
      delivered: 2,
      rejected: 3,
      queued: 4,
      culled: 4,
      "style-matched": 4,
      "recipe-generated": 4,
      applying: 4,
    };
    const items = deps.store
      .listItems(deps.jobId)
      .sort((a, b) => order[a.state] - order[b.state])
      .map((i) => ({
        id: i.assetId,
        state: i.state,
        recipe: i.recipe,
        unsupported: i.recipe ? unsupportedFields(i.recipe, deps.adapter.capabilities.supportedRecipeFields) : [],
        warnings: i.warnings ?? [],
        rejectReason: i.rejectReason,
        restoredFrom: i.restoredFrom,
        errorMessage: i.errorMessage,
        exportedFile: i.exportedFile,
        outlierFields: i.outlierFields ?? [],
        seenBefore: i.seenBefore,
        sceneId: i.sceneId,
        recipeSource: i.recipeSource,
        retouch: i.retouch === true,
        retouchNote: i.retouchNote,
      }));
    return {
      job: deps.jobId,
      adapter: deps.adapter.id,
      rendering: deps.renderPreview !== undefined,
      editing: deps.editingPaused ? { allowed: false, reason: deps.editingPaused } : { allowed: true },
      profile: { name: profile.name, version: profile.version },
      items,
    };
  }

  async function decide(decision: z.infer<typeof DecisionSchema>) {
    const result = await exportApproved(
      { store: deps.store, library: deps.library, adapter: deps.adapter, afterExport: deps.afterExport, ...(deps.logger && { logger: deps.logger }) },
      deps.jobId,
      deps.assets,
      { approve: decision.approve, overrides: decision.overrides, exportSpec: deps.exportSpec },
    );
    const overrides = result.overridden.flatMap((o) => (o.original ? diffOverrides(o.original.adjustments, o.final.adjustments) : []));
    if (overrides.length) {
      profile = learnFromOverrides(profile, overrides);
      await deps.onProfileUpdated?.(profile);
    }
    return {
      exported: result.exported.length,
      approved: result.approved.length,
      failed: result.failed.length,
      profileVersion: profile.version,
    };
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
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
