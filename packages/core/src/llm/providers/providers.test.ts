import { describe, expect, it } from "vitest";
import { LlmGateway } from "../gateway.js";
import type { LlmMessage } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAiCompatibleProvider } from "./openAiCompatible.js";

interface Call {
  url: string;
  init: RequestInit & { signal?: AbortSignal };
  body: any;
}

/** A fetch that records requests and replies from a script. */
function fakeFetch(replies: (Response | Error | ((c: Call) => Response | Promise<Response>))[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit & { signal?: AbortSignal }) => {
    const call = { url: String(url), init, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const next = replies.shift();
    if (!next) throw new Error("no scripted reply left");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(call) : next;
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const messages: LlmMessage[] = [
  { role: "system", content: "be brief" },
  { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mediaType: "image/jpeg", dataBase64: "QUJD" }] },
];

describe("OpenAiCompatibleProvider", () => {
  it("sends the model, messages with data-URL images and JSON mode, and reads text and usage", async () => {
    const { fetch, calls } = fakeFetch([json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 11, completion_tokens: 4 } })]);
    const p = new OpenAiCompatibleProvider({ id: "openai", baseUrl: "https://api.example.com/v1/", apiKey: "sk-test", fetch });
    const res = await p.complete({ model: "gpt-x", messages, json: true, temperature: 0, maxTokens: 50 });

    expect(res).toEqual({ text: '{"ok":true}', usage: { inputTokens: 11, outputTokens: 4 } });
    const c = calls[0]!;
    expect(c.url).toBe("https://api.example.com/v1/chat/completions");
    expect((c.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(c.body).toMatchObject({ model: "gpt-x", temperature: 0, max_tokens: 50, response_format: { type: "json_object" } });
    expect(c.body.messages[1].content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
    ]);
  });

  it("sends no auth header for local servers and tolerates an empty reply", async () => {
    const { fetch, calls } = fakeFetch([json({ choices: [] })]);
    const res = await new OpenAiCompatibleProvider({ id: "ollama", baseUrl: "http://localhost:11434/v1", fetch }).complete({ model: "llava", messages });
    expect(res.text).toBe("");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it.each([
    [401, "LLM_AUTH", false],
    [403, "LLM_AUTH", false],
    [429, "LLM_RATE_LIMIT", true],
    [503, "LLM_RATE_LIMIT", true],
    [400, "LLM_REQUEST_FAILED", false],
  ])("maps HTTP %i to %s (retryable: %s)", async (status, code, retryable) => {
    const { fetch } = fakeFetch([new Response("nope", { status })]);
    const err = await new OpenAiCompatibleProvider({ id: "x", baseUrl: "http://x", fetch }).complete({ model: "m", messages }).catch((e) => e);
    expect(err).toMatchObject({ code, retryable });
    expect(err.message).toContain(String(status));
  });
});

describe("AnthropicProvider", () => {
  it("moves system text to the system field, maps images to base64 sources, and reads usage", async () => {
    const { fetch, calls } = fakeFetch([json({ content: [{ type: "text", text: "hello " }, { type: "tool_use" }, { type: "text", text: "world" }], usage: { input_tokens: 9, output_tokens: 3 } })]);
    const res = await new AnthropicProvider({ apiKey: "k", fetch }).complete({ model: "claude-x", messages, temperature: 0 });

    expect(res).toEqual({ text: "hello world", usage: { inputTokens: 9, outputTokens: 3 } });
    const c = calls[0]!;
    expect(c.url).toBe("https://api.anthropic.com/v1/messages");
    expect(c.init.headers).toMatchObject({ "x-api-key": "k", "anthropic-version": "2023-06-01" });
    expect(c.body.system).toBe("be brief");
    expect(c.body.max_tokens).toBe(4096);
    expect(c.body.messages).toHaveLength(1);
    expect(c.body.messages[0].content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } });
  });

  it("maps errors like the other providers", async () => {
    const err = await new AnthropicProvider({ apiKey: "bad", fetch: fakeFetch([new Response("{}", { status: 401 })]).fetch }).complete({ model: "m", messages }).catch((e) => e);
    expect(err.code).toBe("LLM_AUTH");
  });
});

describe("network failures and timeouts", () => {
  it("treats connection errors as retryable, with a readable cause", async () => {
    const down = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.example.com") });
    const err = await new OpenAiCompatibleProvider({ id: "openai", baseUrl: "http://x", fetch: fakeFetch([down]).fetch }).complete({ model: "m", messages }).catch((e) => e);
    expect(err).toMatchObject({ code: "LLM_REQUEST_FAILED", retryable: true });
    expect(err.message).toMatch(/openai could not be reached: getaddrinfo ENOTFOUND/);
  });

  it("gives up on a hung request after the timeout and reports it as retryable", async () => {
    const hang = (c: Call) => new Promise<Response>((_, reject) => c.init.signal!.addEventListener("abort", () => reject(c.init.signal!.reason)));
    const p = new OpenAiCompatibleProvider({ id: "slow", baseUrl: "http://x", fetch: fakeFetch([hang]).fetch, timeoutMs: 30 });
    const err = await p.complete({ model: "m", messages }).catch((e) => e);
    expect(err).toMatchObject({ code: "LLM_REQUEST_FAILED", retryable: true });
    expect(err.message).toContain("timed out");
  });

  it("lets a user cancel through untouched, so Ctrl-C is not retried", async () => {
    const abort = new AbortController();
    const hang = (c: Call) => new Promise<Response>((_, reject) => c.init.signal!.addEventListener("abort", () => reject(c.init.signal!.reason)));
    const p = new AnthropicProvider({ apiKey: "k", fetch: fakeFetch([hang]).fetch });
    const pending = p.complete({ model: "m", messages, signal: abort.signal }).catch((e) => e);
    abort.abort();
    const err = await pending;
    expect(err).not.toHaveProperty("retryable", true);
    expect(err.name).toBe("AbortError");
  });

  it("the gateway retries a dropped connection with backoff and then succeeds", async () => {
    const slept: number[] = [];
    const { fetch } = fakeFetch([new TypeError("fetch failed"), new TypeError("fetch failed"), json({ choices: [{ message: { content: "ok" } }] })]);
    const gateway = new LlmGateway({ retry: { attempts: 3, baseDelayMs: 100 }, sleep: async (ms) => void slept.push(ms) })
      .registerProvider(new OpenAiCompatibleProvider({ id: "p", baseUrl: "http://x", fetch }))
      .setRoute("vision", { providerId: "p", model: "m" });
    expect((await gateway.complete("vision", { messages })).text).toBe("ok");
    expect(slept).toHaveLength(2);
    expect(slept[1]!).toBeGreaterThan(slept[0]!);
  });
});
