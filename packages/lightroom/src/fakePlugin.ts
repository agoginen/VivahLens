import type { PluginBridge } from "@vivahlens/core";

type Message = Record<string, unknown>;
type Handler = (message: Message) => Promise<Message | undefined> | Message | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stands in for the Lua plugin in tests: polls the bridge the way the plugin does, carries out one request at a time, and
 * answers with whatever `handle` returns (returning nothing keeps it silent, like a plugin that is stuck).
 */
export class FakePlugin {
  readonly seen: Message[] = [];
  private stopped = false;

  constructor(
    private readonly bridge: Pick<PluginBridge, "port" | "token">,
    private readonly handle: Handler,
    private readonly identity: { plugin: string; version: string; host?: string } = { plugin: "vivahlens-lrc", version: "1.0" },
  ) {
    void this.run();
  }

  /** Reports progress as the plugin does; the reply names the jobs the agent has cancelled. */
  async progress(body: Message): Promise<{ cancelled: string[] }> {
    const res = await this.call("/v1/progress", "POST", body);
    return (await res.json()) as { cancelled: string[] };
  }

  stop(): void {
    this.stopped = true;
  }

  private call(route: string, method: "GET" | "POST", body?: Message): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.bridge.port}${route}`, {
      method,
      headers: { "x-vivah-token": this.bridge.token, "content-type": "application/json" },
      ...(body && { body: JSON.stringify(body) }),
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let res: Response;
      try {
        res = await this.call(`/v1/next?wait=200&plugin=${this.identity.plugin}&version=${this.identity.version}${this.identity.host ? `&host=${this.identity.host}` : ""}`, "GET");
      } catch {
        await sleep(10);
        continue;
      }
      if (res.status !== 200) {
        await res.arrayBuffer();
        continue;
      }
      const message = (await res.json()) as Message;
      this.seen.push(message);
      const reply = await this.handle(message);
      if (reply) await this.call(`/v1/reply/${String(message.id)}`, "POST", reply).then((r) => r.arrayBuffer(), () => undefined);
    }
  }
}

/** Waits until the bridge has heard from the plugin. */
export async function untilConnected(bridge: Pick<PluginBridge, "connected">): Promise<void> {
  for (let i = 0; i < 300 && !bridge.connected(); i++) await sleep(10);
  if (!bridge.connected()) throw new Error("the fake plugin never connected");
}

export async function until(check: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await sleep(10);
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}
