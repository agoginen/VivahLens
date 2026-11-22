import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { VivahError } from "../errors.js";
import { writePrivateFile } from "../platform/privateFile.js";
import { ProgressChannel } from "./progress.js";

/**
 * How the agent talks to a plugin running inside an editor (Lightroom Classic, Premiere Pro): a loopback HTTP server that
 * the plugin long-polls. The agent is always the server because those plugin runtimes can open client connections but
 * not (reliably) listen; the plugin finds the port and token in a handshake file under the user's profile.
 *
 * Every request carries `X-Vivah-Token`.
 *
 *   GET  /v1/ping                           → 200 {ok, protocol}                       (checks the token, changes nothing)
 *   GET  /v1/next?wait=<ms>&plugin=&version=&host=
 *                                           → 200 {id, type, jobId?, …}  a request for the plugin to carry out
 *                                           → 204 nothing came up within `wait`
 *   POST /v1/reply/<id>   {ok, error?, …}   → 204  the plugin's answer to request <id>
 *   POST /v1/progress     {stage, done, total, jobId?, assetId?, message?}
 *                                           → 200 {cancelled: [jobId, …]}  jobs the agent has given up on
 *
 * A request is handed to the plugin once (at most once); when the plugin dies halfway the agent's request times out.
 * Work already running inside the editor cannot be interrupted, only abandoned, so cancellation is advisory: queued requests
 * of the job are dropped, the waiting caller is released, and the plugin learns the job id from its next progress reply.
 */
export const BRIDGE_PROTOCOL = 1;

export interface BridgeHandshake {
  protocol: number;
  port: number;
  token: string;
}

export interface PluginHello {
  plugin: string;
  version: string;
  /** The editor's own version, when the plugin reports it. */
  host?: string;
}

export interface PluginBridgeOptions {
  /** Listens on this port; the default lets the system pick one. */
  port?: number;
  /** A fixed token, for plugins that are paired once by hand; the default is a fresh random one. */
  token?: string;
  /** What the errors call the plugin ("Lightroom plugin"). */
  name?: string;
  /** How long a request waits for the plugin's reply. */
  timeoutMs?: number;
  /** How long after its last contact a plugin still counts as connected; plugins poll every few seconds. */
  livenessMs?: number;
  /** The longest the server holds one poll open. */
  maxPollMs?: number;
}

export interface RequestOptions {
  /** Ties the request to a job, so cancelling the job cancels it. */
  jobId?: string;
  signal?: AbortSignal;
  /** Overrides the server's timeout for work that is expected to take long (importing a folder). */
  timeoutMs?: number;
}

interface Reply {
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  /** Whatever else the plugin put in its reply (imported files, a snapshot name). */
  data: Record<string, unknown>;
}

interface Pending {
  resolve(value: Reply): void;
  timer: NodeJS.Timeout;
  jobId: string | undefined;
  delivered: boolean;
}

interface Outgoing {
  id: string;
  body: string;
}

const MAX_BODY_BYTES = 4_000_000;
const RECENTLY_CANCELLED = 100;

const header = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));

function send(res: http.ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status, { "Cache-Control": "no-store" });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
  res.end(text);
}

async function readObject(req: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export class PluginBridge {
  readonly token: string;
  /** What the plugin reports about its own work, for `EditorAdapter.getProgress`. */
  readonly progress = new ProgressChannel();
  port = 0;
  private readonly server: http.Server;
  private readonly name: string;
  private readonly timeoutMs: number;
  private readonly livenessMs: number;
  private readonly maxPollMs: number;
  private queue: Outgoing[] = [];
  private readonly pending = new Map<string, Pending>();
  private poll: { res: http.ServerResponse; timer: NodeJS.Timeout } | undefined;
  private hello: PluginHello | undefined;
  private lastSeen = 0;
  private readonly cancelled: string[] = [];

  constructor(private readonly opts: PluginBridgeOptions = {}) {
    this.token = opts.token ?? randomBytes(24).toString("base64url");
    this.name = opts.name ?? "Editor plugin";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.livenessMs = opts.livenessMs ?? 15_000;
    this.maxPollMs = opts.maxPollMs ?? 25_000;
    this.server = http.createServer((req, res) => {
      this.route(req, res).catch(() => {
        if (!res.headersSent) send(res, 500, { error: "internal error" });
        else res.end();
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.port ?? 0, "127.0.0.1", () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** What the plugin needs to find this server; the caller writes it to a user-private file. */
  handshake(): BridgeHandshake {
    return { protocol: BRIDGE_PROTOCOL, port: this.port, token: this.token };
  }

  /** The plugin, while it is polling or working on a request; undefined when it was never seen or has gone quiet. */
  connected(): PluginHello | undefined {
    if (!this.hello) return undefined;
    const working = [...this.pending.values()].some((p) => p.delivered);
    const alive = this.poll !== undefined || working || Date.now() - this.lastSeen <= this.livenessMs;
    return alive ? this.hello : undefined;
  }

  /** Sends one request and returns the plugin's reply fields. Rejects when the plugin is absent, refuses, is silent too long, or the job is cancelled. */
  async request(message: Record<string, unknown>, opts: RequestOptions = {}): Promise<Record<string, unknown>> {
    if (!this.connected()) {
      throw new VivahError("ADAPTER_EDITOR_NOT_RUNNING", `The ${this.name} is not connected. Open the editor and enable the VivahLens plugin.`);
    }
    if (opts.signal?.aborted) throw new VivahError("ADAPTER_CANCELLED", `Cancelled before the request was sent to the ${this.name}`);

    const id = randomUUID();
    const reply = new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => {
        this.forget(id);
        resolve({ ok: false, error: "plugin did not respond in time", data: {} });
      }, opts.timeoutMs ?? this.timeoutMs);
      this.pending.set(id, { resolve, timer, jobId: opts.jobId, delivered: false });
    });
    const onAbort = () => this.cancelJob(opts.jobId, id);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    this.enqueue({ id, body: JSON.stringify({ ...message, id, ...(opts.jobId && { jobId: opts.jobId }) }) });
    let result: Reply;
    try {
      result = await reply;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
    if (result.cancelled) throw new VivahError("ADAPTER_CANCELLED", `The request to the ${this.name} was cancelled`);
    if (!result.ok) throw new VivahError("ADAPTER_APPLY_FAILED", `${this.name}: ${result.error ?? "unknown error"}`);
    return result.data;
  }

  /**
   * Stops waiting for everything asked on behalf of a job (or for one request when no job is given) and drops what has
   * not been handed to the plugin yet. Work the editor is already doing cannot be interrupted, only abandoned.
   */
  cancelJob(jobId: string | undefined, requestId?: string): void {
    for (const [id, pending] of [...this.pending]) {
      if (id !== requestId && (jobId === undefined || pending.jobId !== jobId)) continue;
      this.forget(id);
      pending.resolve({ ok: false, cancelled: true, data: {} });
    }
    if (jobId !== undefined) {
      this.cancelled.push(jobId);
      if (this.cancelled.length > RECENTLY_CANCELLED) this.cancelled.shift();
    }
  }

  async close(): Promise<void> {
    const released = this.endPoll();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.queue = [];
    this.progress.close();
    await released;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeIdleConnections();
      // Whatever is still open after a moment is not going to finish.
      setTimeout(() => this.server.closeAllConnections(), 250).unref();
    });
  }

  private forget(id: string): void {
    const pending = this.pending.get(id);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(id);
    this.queue = this.queue.filter((m) => m.id !== id);
  }

  private enqueue(message: Outgoing): void {
    this.queue.push(message);
    const poll = this.poll;
    if (!poll) return;
    this.poll = undefined;
    clearTimeout(poll.timer);
    this.deliver(poll.res, this.queue.shift()!);
  }

  private deliver(res: http.ServerResponse, message: Outgoing): void {
    const pending = this.pending.get(message.id);
    if (pending) pending.delivered = true;
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(message.body), "Cache-Control": "no-store" });
    res.end(message.body);
  }

  /** Answers the held poll (nothing to do) so the plugin asks again; resolves once the answer has been sent. */
  private endPoll(): Promise<void> {
    const poll = this.poll;
    if (!poll) return Promise.resolve();
    this.poll = undefined;
    clearTimeout(poll.timer);
    const sent = new Promise<void>((resolve) => {
      poll.res.once("finish", () => resolve());
      poll.res.once("close", () => resolve());
    });
    send(poll.res, 204);
    return sent;
  }

  private hostOk(host: string): boolean {
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`].includes(host.toLowerCase());
  }

  private tokenOk(given: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // A page in a browser cannot get past either check: it does not know the token, and a rebound hostname fails the host test.
    if (!this.hostOk(header(req.headers.host))) return send(res, 403, { error: "forbidden" });
    if (!this.tokenOk(header(req.headers["x-vivah-token"]))) return send(res, 401, { error: "unauthorized" });

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const replyTo = /^\/v1\/reply\/([\w-]{1,80})$/.exec(url.pathname);
    if (req.method === "GET" && url.pathname === "/v1/ping") return send(res, 200, { ok: true, protocol: BRIDGE_PROTOCOL });
    if (req.method === "GET" && url.pathname === "/v1/next") return this.next(url, res);
    if (req.method === "POST" && replyTo) return this.reply(req, res, replyTo[1]!);
    if (req.method === "POST" && url.pathname === "/v1/progress") return this.progressFrom(req, res);
    return send(res, 404, { error: "not found" });
  }

  private next(url: URL, res: http.ServerResponse): void {
    this.lastSeen = Date.now();
    const plugin = url.searchParams.get("plugin");
    if (plugin) {
      const host = url.searchParams.get("host");
      this.hello = { plugin: plugin.slice(0, 60), version: (url.searchParams.get("version") ?? "").slice(0, 40), ...(host && { host: host.slice(0, 40) }) };
    }
    this.endPoll(); // a restarted plugin may leave its previous poll behind
    const waiting = this.queue.shift();
    if (waiting) return this.deliver(res, waiting);
    const wait = Math.min(Number(url.searchParams.get("wait")), this.maxPollMs);
    if (!(wait > 0)) return send(res, 204);
    const poll = { res, timer: setTimeout(() => this.endPoll(), wait) };
    this.poll = poll;
    res.on("close", () => {
      if (this.poll !== poll) return;
      clearTimeout(poll.timer);
      this.poll = undefined;
    });
  }

  private async reply(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    this.lastSeen = Date.now();
    const body = await readObject(req);
    if (!body) return send(res, 400, { error: "expected a JSON object" });
    const pending = this.pending.get(id);
    if (!pending) return send(res, 404, { error: "unknown or expired request" });
    this.forget(id);
    const { ok, error, ...data } = body;
    pending.resolve({ ok: ok === true, ...(typeof error === "string" && { error }), data });
    send(res, 204);
  }

  /** Passes on only well-formed progress; a misbehaving plugin cannot push anything else into the agent. */
  private async progressFrom(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.lastSeen = Date.now();
    const msg = await readObject(req);
    if (!msg) return send(res, 400, { error: "expected a JSON object" });
    const { stage, done, total } = msg;
    if (typeof stage === "string" && typeof done === "number" && typeof total === "number" && Number.isFinite(done) && Number.isFinite(total)) {
      this.progress.emit({
        stage: stage.slice(0, 80),
        done,
        total,
        ...(typeof msg.jobId === "string" && { jobId: msg.jobId }),
        ...(typeof msg.assetId === "string" && { assetId: msg.assetId }),
        ...(typeof msg.message === "string" && { message: msg.message.slice(0, 300) }),
      });
    }
    send(res, 200, { cancelled: this.cancelled });
  }
}

/** Writes the handshake so the plugin never sees a half-written file, readable by this user only (restricted with icacls on Windows, where a file mode does nothing). */
export async function writeBridgeHandshake(file: string, handshake: BridgeHandshake): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writePrivateFile(file, JSON.stringify(handshake));
}

/** Removes the handshake unless another agent has replaced it since. */
export async function removeBridgeHandshake(file: string, token: string): Promise<void> {
  try {
    const current = JSON.parse(await fs.readFile(file, "utf8")) as { token?: unknown };
    if (current.token === token) await fs.rm(file, { force: true });
  } catch {
    // Missing or unreadable: nothing of ours to remove.
  }
}
