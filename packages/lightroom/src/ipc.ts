import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import net from "node:net";
import { VivahError } from "@vivahlens/core";

/**
 * Agent ↔ in-editor plugin protocol: newline-delimited JSON over a loopback TCP socket.
 *
 *   plugin → agent  {"type":"hello","token":"…","plugin":"vivahlens-lrc","version":"1.0"}
 *   agent  → plugin {"type":"ready"}                       (or the socket is closed on a bad token)
 *   agent  → plugin {"id":"…","type":"apply","path":"…","settings":{…}}
 *   plugin → agent  {"id":"…","ok":true} | {"id":"…","ok":false,"error":"…"}
 *
 * The plugin is the TCP client because Lightroom Classic's Lua SDK exposes sockets (LrSocket); the agent
 * hands it the port and token through a file under the user profile, never on a command line.
 */
export interface PluginHello {
  plugin: string;
  version: string;
}

export interface PluginIpcOptions {
  port?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
}

interface Pending {
  resolve(value: { ok: boolean; error?: string }): void;
  timer: NodeJS.Timeout;
}

const MAX_LINE_BYTES = 1_000_000;

export class PluginIpcServer {
  readonly token = randomBytes(24).toString("base64url");
  private readonly server: net.Server;
  private socket: net.Socket | undefined;
  private hello: PluginHello | undefined;
  private pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  port = 0;

  constructor(private readonly opts: PluginIpcOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.server = net.createServer((s) => this.accept(s));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.port ?? 0, "127.0.0.1", () => resolve());
    });
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  /** Details the plugin needs to connect; written to a user-private file by the caller. */
  handshake(): { port: number; token: string } {
    return { port: this.port, token: this.token };
  }

  connected(): PluginHello | undefined {
    return this.socket && !this.socket.destroyed ? this.hello : undefined;
  }

  async request(message: Record<string, unknown>): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed || !this.hello) {
      throw new VivahError("ADAPTER_EDITOR_NOT_RUNNING", "The Lightroom plugin is not connected. Open Lightroom Classic and enable the VivahLens plugin.");
    }
    const id = randomUUID();
    const reply = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: "plugin did not respond in time" });
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
    });
    socket.write(`${JSON.stringify({ ...message, id })}\n`);
    const result = await reply;
    if (!result.ok) throw new VivahError("ADAPTER_APPLY_FAILED", `Lightroom plugin: ${result.error ?? "unknown error"}`);
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(socket: net.Socket): void {
    let buffer = "";
    let authed = false;
    const drop = () => socket.destroy();
    // A silent connection must not hold the single plugin slot.
    const helloTimer = setTimeout(() => !authed && drop(), 5_000);

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) return drop();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return drop();
        }
        if (!authed) {
          if (msg.type !== "hello" || typeof msg.token !== "string" || !this.tokenOk(msg.token)) return drop();
          authed = true;
          clearTimeout(helloTimer);
          this.socket?.destroy();
          this.socket = socket;
          this.hello = { plugin: String(msg.plugin ?? "unknown"), version: String(msg.version ?? "") };
          socket.write(`${JSON.stringify({ type: "ready" })}\n`);
        } else if (typeof msg.id === "string") {
          const pending = this.pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(msg.id);
            pending.resolve({ ok: msg.ok === true, error: typeof msg.error === "string" ? msg.error : undefined });
          }
        }
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (this.socket === socket) this.socket = undefined;
    });
  }

  private tokenOk(given: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
