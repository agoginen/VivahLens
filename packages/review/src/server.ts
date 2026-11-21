import { timingSafeEqual, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import {
  diffOverrides,
  EditRecipeSchema,
  exportApproved,
  learnFromOverrides,
  unsupportedFields,
  type AssetRef,
  type EditorAdapter,
  type ExportSpec,
  type JobStore,
  type LibraryStore,
  type Preview,
  type StyleProfile,
} from "@vivahlens/core";
import { reviewPage } from "./ui.js";

export interface ReviewDeps {
  store: JobStore;
  /** Records reviewer corrections and the audit trail when provided. */
  library?: LibraryStore;
  jobId: string;
  assets: readonly AssetRef[];
  adapter: EditorAdapter;
  profile: StyleProfile;
  /** Smaller previews than the LLM gets are fine here; callers usually pass a ~1024px loader. */
  previewOf(asset: AssetRef): Promise<Preview>;
  /** Required when the adapter can export. */
  exportSpec?: ExportSpec;
  /** Called with the profile after reviewer overrides have nudged it. */
  onProfileUpdated?(profile: StyleProfile): void | Promise<void>;
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

const MAX_BODY_BYTES = 1_000_000;

/**
 * Local-only review UI (plan §4): before/after grid, per-photo sliders that map to recipe fields, approve, submit.
 * Security: binds to 127.0.0.1, requires an unguessable token, validates Host (DNS rebinding) and requires a
 * JSON content type on writes (cross-site form posts cannot send one).
 */
export async function startReviewServer(deps: ReviewDeps, opts: { port?: number } = {}): Promise<ReviewServer> {
  const token = randomBytes(24).toString("base64url");
  const previews = new Map<string, Promise<Buffer>>();
  const assetsById = new Map(deps.assets.map((a) => [a.id, a]));
  let profile = deps.profile;
  let queue: Promise<unknown> = Promise.resolve();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { error: err instanceof Error ? err.message : "internal error" }));
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const port = (server.address() as AddressInfo).port;
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: "bad host" });

    const url = new URL(req.url ?? "/", `http://${host}`);
    if (!tokenOk(url.searchParams.get("t") ?? "", token)) return send(res, 401, { error: "unauthorized" });

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; img-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      res.end(reviewPage(token));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, listing());
    if (req.method === "GET" && url.pathname.startsWith("/api/preview/")) {
      const asset = assetsById.get(decodeURIComponent(url.pathname.slice("/api/preview/".length)));
      if (!asset) return send(res, 404, { error: "unknown asset" });
      if (!previews.has(asset.id)) previews.set(asset.id, deps.previewOf(asset).then((p) => Buffer.from(p.dataBase64, "base64")));
      const bytes = await previews.get(asset.id)!;
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=300" });
      res.end(bytes);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/decide") {
      if (!String(req.headers["content-type"]).startsWith("application/json")) return send(res, 415, { error: "json required" });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: "invalid JSON" });
      }
      const parsed = DecisionSchema.safeParse(body);
      if (!parsed.success) return send(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid decision" });
      const result = queue.then(() => decide(parsed.data));
      queue = result.catch(() => undefined);
      return send(res, 200, await result);
    }
    send(res, 404, { error: "not found" });
  }

  function listing() {
    const order = { review: 0, failed: 1, approved: 2, exported: 2, rejected: 3, culled: 4, queued: 4, "recipe-generated": 4 } as const;
    const items = deps.store
      .listItems(deps.jobId)
      .sort((a, b) => order[a.state] - order[b.state])
      .map((i) => ({
        id: i.assetId,
        state: i.state,
        recipe: i.recipe,
        unsupported: i.recipe ? unsupportedFields(i.recipe, deps.adapter.capabilities.supportedRecipeFields) : [],
        rejectReason: i.rejectReason,
        errorMessage: i.errorMessage,
        exportedFile: i.exportedFile,
        outlierFields: i.outlierFields ?? [],
        seenBefore: i.seenBefore,
        sceneId: i.sceneId,
      }));
    return { job: deps.jobId, adapter: deps.adapter.id, profile: { name: profile.name, version: profile.version }, items };
  }

  async function decide(decision: z.infer<typeof DecisionSchema>) {
    const result = await exportApproved(
      { store: deps.store, library: deps.library, adapter: deps.adapter },
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

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
