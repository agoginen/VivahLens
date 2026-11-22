import { describe, expect, it, vi } from "vitest";
import { VivahError } from "../errors.js";
import { runJob } from "../pipeline/runJob.js";
import { MemoryStore } from "../pipeline/libraryStore.js";
import type { AssetRef, EditorAdapter } from "../adapters/editorAdapter.js";
import { layerOnto, PHOTO_EDIT_REPLY, readCompactReply, STYLE_REPLY, withoutNeutralSliders } from "../style/replySchemas.js";
import { learnStyle, proposeRecipe } from "../style/styleEngine.js";
import type { StyleProfile } from "../style/styleProfile.js";
import { LlmGateway } from "./gateway.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { httpError } from "./providers/http.js";
import { OpenAiCompatibleProvider } from "./providers/openAiCompatible.js";
import type { LlmRequest } from "./types.js";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

/** Answers each request in turn with the next canned response and records what was sent. */
function fakeFetch(...replies: (Response | (() => Response))[]) {
  const sent: Sent[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: JSON.parse(String(init?.body)) });
    const next = replies.shift();
    if (!next) throw new Error("no more canned replies");
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { impl, sent };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const openAiReply = (content: string, extra: Record<string, unknown> = {}) => json({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 }, ...extra });
const request = (over: Partial<LlmRequest> = {}): LlmRequest => ({ model: "m", messages: [{ role: "user", content: "hi" }], ...over });
const schema = { name: "photo_edit", schema: { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "number" } } } };

describe("OpenAiCompatibleProvider and structured output", () => {
  it("asks for the schema with strict enforcement when it is given one, and for plain JSON when it is only asked for JSON", async () => {
    const { impl, sent } = fakeFetch(openAiReply("{}"), openAiReply("{}"), openAiReply("hello"));
    const p = new OpenAiCompatibleProvider({ id: "openai", baseUrl: "https://api.example.com/v1", apiKey: "k", fetch: impl });

    await p.complete(request({ json: true, jsonSchema: schema, temperature: 0 }));
    await p.complete(request({ json: true }));
    await p.complete(request());

    expect(sent[0]!.body.response_format).toEqual({ type: "json_schema", json_schema: { name: "photo_edit", strict: true, schema: schema.schema } });
    expect(sent[0]!.body.temperature).toBe(0);
    expect(sent[1]!.body.response_format).toEqual({ type: "json_object" });
    expect(sent[2]!.body.response_format).toBeUndefined();
    expect(sent[0]!.headers.authorization).toBe("Bearer k");
  });

  it("authenticates with the api-key header for Azure", async () => {
    const { impl, sent } = fakeFetch(openAiReply("{}"));
    await new OpenAiCompatibleProvider({ id: "azure", baseUrl: "https://r.openai.azure.com/openai/v1", apiKey: "azure-key", authHeader: "api-key", fetch: impl }).complete(request());
    expect(sent[0]!.headers["api-key"]).toBe("azure-key");
    expect(sent[0]!.headers.authorization).toBeUndefined();
  });

  it("steps down from a schema to JSON mode to nothing when the endpoint refuses, and remembers what it learned", async () => {
    const refuse = (what: string) => json({ error: { message: `Unsupported parameter: ${what}` } }, 400);
    const { impl, sent } = fakeFetch(refuse("response_format json_schema"), refuse("response_format"), openAiReply("{}"), openAiReply("{}"));
    const p = new OpenAiCompatibleProvider({ id: "local", baseUrl: "https://llm.example.com/v1", fetch: impl });

    await expect(p.complete(request({ json: true, jsonSchema: schema }))).resolves.toMatchObject({ text: "{}" });
    expect(sent.map((s) => s.body.response_format?.type)).toEqual(["json_schema", "json_object", undefined]);

    await p.complete(request({ json: true, jsonSchema: schema }));
    expect(sent).toHaveLength(4);
    expect(sent[3]!.body.response_format).toBeUndefined();
  });

  it("drops a temperature that the model rejects, for this request and the ones after it, but does not retry unrelated refusals", async () => {
    const { impl, sent } = fakeFetch(json({ error: { message: "Unsupported value: 'temperature' does not support 0 with this model." } }, 400), openAiReply("{}"), openAiReply("{}"));
    const p = new OpenAiCompatibleProvider({ id: "openai", baseUrl: "https://api.example.com/v1", fetch: impl });

    await p.complete(request({ temperature: 0 }));
    await p.complete(request({ temperature: 0 }));
    expect(sent.map((s) => s.body.temperature)).toEqual([0, undefined, undefined]);

    const other = fakeFetch(json({ error: { message: "The image could not be decoded" } }, 400));
    await expect(new OpenAiCompatibleProvider({ id: "openai", baseUrl: "https://api.example.com/v1", fetch: other.impl }).complete(request({ temperature: 0, json: true }))).rejects.toMatchObject({ code: "LLM_REQUEST_FAILED" });
    expect(other.sent).toHaveLength(1);
  });

  it("reports reasoning and cached tokens when the provider says so, and turns a refusal or a content filter into its own error", async () => {
    const { impl } = fakeFetch(
      json({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 100, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 45 } } }),
      json({ choices: [{ message: { content: null, refusal: "I can't help with that." } }] }),
      json({ choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }),
    );
    const p = new OpenAiCompatibleProvider({ id: "openai", baseUrl: "https://api.example.com/v1", fetch: impl });

    expect((await p.complete(request())).usage).toEqual({ inputTokens: 100, outputTokens: 60, reasoningTokens: 45, cachedInputTokens: 40 });
    await expect(p.complete(request())).rejects.toMatchObject({ code: "LLM_REFUSED" });
    await expect(p.complete(request())).rejects.toMatchObject({ code: "LLM_CONTENT_FILTERED" });
  });
});

describe("AnthropicProvider and structured output", () => {
  const reply = (over: Record<string, unknown> = {}) => json({ content: [{ type: "text", text: "{}" }], usage: { input_tokens: 10, output_tokens: 5 }, ...over });

  it("asks for the schema through output_config, and sends nothing extra without one", async () => {
    const { impl, sent } = fakeFetch(reply(), reply());
    const p = new AnthropicProvider({ apiKey: "k", fetch: impl });
    await p.complete(request({ json: true, jsonSchema: schema }));
    await p.complete(request({ json: true }));

    expect(sent[0]!.body.output_config).toEqual({ format: { type: "json_schema", schema: schema.schema } });
    expect(sent[1]!.body.output_config).toBeUndefined();
    expect(sent[0]!.headers["x-api-key"]).toBe("k");
  });

  it("falls back to an unenforced reply when the schema is refused, and drops a temperature the model will not take", async () => {
    const { impl, sent } = fakeFetch(
      json({ type: "error", error: { type: "invalid_request_error", message: "Schema is too complex for compilation." } }, 400),
      json({ type: "error", error: { type: "invalid_request_error", message: "`temperature` is not supported for this model" } }, 400),
      reply(),
    );
    const p = new AnthropicProvider({ apiKey: "k", fetch: impl });

    await expect(p.complete(request({ json: true, jsonSchema: schema, temperature: 0 }))).resolves.toMatchObject({ text: "{}" });
    expect(sent.map((s) => [s.body.output_config !== undefined, s.body.temperature])).toEqual([[true, 0], [false, 0], [false, undefined]]);
  });

  it("counts the cached input in the input total, reports thinking tokens, and treats a refusal as its own error", async () => {
    const { impl } = fakeFetch(
      reply({ usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 80, output_tokens_details: { thinking_tokens: 50 } } }),
      reply({ stop_reason: "refusal", content: [] }),
    );
    const p = new AnthropicProvider({ apiKey: "k", fetch: impl });
    expect((await p.complete(request())).usage).toEqual({ inputTokens: 510, outputTokens: 80, reasoningTokens: 50, cachedInputTokens: 300 });
    await expect(p.complete(request())).rejects.toMatchObject({ code: "LLM_REFUSED" });
  });
});

describe("httpError", () => {
  const classify = (status: number, body: unknown, headers: Record<string, string> = {}) => httpError("p", new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }));

  it("keeps rate limits and overload retryable and carries the provider's own wait, in seconds, milliseconds or as a date", async () => {
    expect(await classify(429, { error: { message: "slow down" } }, { "retry-after": "7" })).toMatchObject({ code: "LLM_RATE_LIMIT", retryable: true, retryAfterMs: 7000 });
    expect(await classify(429, {}, { "retry-after-ms": "250", "retry-after": "9" })).toMatchObject({ retryAfterMs: 250 });
    expect(await classify(503, {})).toMatchObject({ code: "LLM_RATE_LIMIT", retryable: true, retryAfterMs: undefined });
    expect(await classify(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })).toMatchObject({ retryable: true });
    const later = new Date(Date.now() + 30_000).toUTCString();
    const dated = await classify(429, {}, { "retry-after": later });
    expect(dated.retryAfterMs).toBeGreaterThan(20_000);
    expect(dated.retryAfterMs).toBeLessThanOrEqual(30_000);
    expect(await classify(429, {}, { "retry-after": "soon" })).toMatchObject({ retryAfterMs: undefined });
  });

  it("does not retry a spend or credit limit, and says so in words a photographer can act on", async () => {
    for (const [status, body] of [
      [429, { error: { code: "insufficient_quota", type: "insufficient_quota", message: "You exceeded your current quota" } }],
      [402, { error: { code: "RESOURCE_EXHAUSTED", message: "Prepay credits depleted" } }],
      [429, { type: "error", error: { type: "billing_error", message: "Your credit balance is too low" } }],
      [400, { error: { message: "credit_balance_too_low" } }],
    ] as const) {
      const err = await classify(status, body);
      expect(err, JSON.stringify(body)).toMatchObject({ code: "LLM_QUOTA_EXCEEDED", retryable: false });
      expect(err.message).toMatch(/out of credit or at its spend limit/);
    }
  });

  it("tells a content filter from a bad request, and a bad key from both", async () => {
    expect(await classify(400, { error: { code: "content_filter", message: "The response was filtered" } })).toMatchObject({ code: "LLM_CONTENT_FILTERED", retryable: false });
    expect(await classify(400, { error: { message: "image too large" } })).toMatchObject({ code: "LLM_REQUEST_FAILED" });
    expect(await classify(401, {})).toMatchObject({ code: "LLM_AUTH" });
    expect(await classify(403, "forbidden")).toMatchObject({ code: "LLM_AUTH" });
    expect(await classify(400, "not json at all")).toMatchObject({ code: "LLM_REQUEST_FAILED" });
  });
});

describe("the gateway honours a provider's wait", () => {
  const limited = (retryAfterMs: number | undefined) => {
    let calls = 0;
    const gateway = new LlmGateway({ retry: { attempts: 3, baseDelayMs: 10 }, sleep: vi.fn(async () => undefined) });
    gateway.registerProvider({
      id: "p",
      complete: async () => {
        if (++calls < 2) throw new VivahError("LLM_RATE_LIMIT", "slow", true, retryAfterMs);
        return { text: "ok" };
      },
    });
    gateway.setRoute("vision", { providerId: "p", model: "m" });
    return { gateway, calls: () => calls, sleep: (gateway as unknown as { sleep: ReturnType<typeof vi.fn> }).sleep };
  };

  it("waits at least as long as it was told to", async () => {
    const { gateway, sleep } = limited(5000);
    await gateway.complete("vision", { messages: [{ role: "user", content: "x" }] });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(5000);
  });

  it("gives up at once on a wait of several minutes instead of hanging a batch", async () => {
    const { gateway, calls } = limited(10 * 60_000);
    await expect(gateway.complete("vision", { messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "LLM_RATE_LIMIT" });
    expect(calls()).toBe(1);
  });
});

describe("the schemas sent to providers", () => {
  /** Every rule the strictest provider has: all properties required, no extras, and none of the keywords some providers reject. */
  function strictProblems(node: unknown, path = "$"): string[] {
    if (typeof node !== "object" || node === null) return [];
    const n = node as Record<string, unknown>;
    const problems: string[] = [];
    for (const banned of ["minimum", "maximum", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "oneOf", "allOf", "$ref"]) {
      if (banned in n) problems.push(`${path} uses ${banned}`);
    }
    if (n.type === "object") {
      const props = Object.keys((n.properties as object) ?? {});
      if (n.additionalProperties !== false) problems.push(`${path} allows extra properties`);
      if (JSON.stringify([...((n.required as string[]) ?? [])].sort()) !== JSON.stringify([...props].sort())) problems.push(`${path} does not require every property`);
      for (const [k, v] of Object.entries((n.properties as object) ?? {})) problems.push(...strictProblems(v, `${path}.${k}`));
    }
    return problems;
  }

  it("fit the portable subset of strict mode, and stay well under Anthropic's limit on optional parameters", () => {
    expect(strictProblems(PHOTO_EDIT_REPLY.schema)).toEqual([]);
    expect(strictProblems(STYLE_REPLY.schema)).toEqual([]);
    expect(PHOTO_EDIT_REPLY.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("read 0 as unchanged: white balance of zero is not a setting, and zero sliders are left out unless the style sets them", () => {
    expect(readCompactReply({ adjustments: { exposure: 0.4, whiteBalance: { tempK: 0, tint: 0 } }, confidence: 0.8 })).toEqual({ adjustments: { exposure: 0.4 }, confidence: 0.8 });
    expect(readCompactReply({ adjustments: { whiteBalance: { tempK: 5200, tint: 0 } } })).toEqual({ adjustments: { whiteBalance: { tempK: 5200 } } });
    expect(readCompactReply({ summary: "s", baseAdjustments: { whiteBalance: { tempK: 0, tint: 0 } } })).toEqual({ summary: "s", baseAdjustments: {} });
    expect(readCompactReply("not an object")).toBe("not an object");

    expect(withoutNeutralSliders({ exposure: 0, contrast: 0, shadows: 20 }, { contrast: 12 })).toEqual({ contrast: 0, shadows: 20 });
  });

  it("lay the model's corrections over the style, deeply, so what it does not mention stays", () => {
    const style = { exposure: 0.3, whiteBalance: { tempK: 5400, tint: 4 }, hsl: { orange: { hue: 5 } }, toneCurve: [{ input: 0, output: 0 }] };
    expect(layerOnto(style, { exposure: 0.8, whiteBalance: { tempK: 5000 } })).toEqual({ exposure: 0.8, whiteBalance: { tempK: 5000, tint: 4 }, hsl: { orange: { hue: 5 } }, toneCurve: [{ input: 0, output: 0 }] });
  });
});

const profile: StyleProfile = { id: "warm", name: "Warm", version: 1, summary: "warm and airy", baseAdjustments: { exposure: 0.3, contrast: 12, hsl: { orange: { hue: 5 } }, whiteBalance: { tempK: 5400 } } };
const preview = { mediaType: "image/jpeg", dataBase64: "AAAA" };

function gatewayReplying(reply: unknown) {
  const requests: LlmRequest[] = [];
  const gateway = new LlmGateway()
    .registerProvider({ id: "p", complete: async (req) => (requests.push(req), { text: JSON.stringify(reply) }) })
    .setRoute("vision", { providerId: "p", model: "m" });
  return { gateway, requests };
}

describe("proposeRecipe with the compact reply", () => {
  it("asks providers to enforce the schema, keeps the style's own settings, and lets the model change what it sets", async () => {
    const { gateway, requests } = gatewayReplying({
      adjustments: { exposure: -0.4, contrast: 12, highlights: 0, shadows: 18, whites: 0, blacks: 0, vibrance: 0, saturation: 0, whiteBalance: { tempK: 0, tint: 0 } },
      confidence: 0.7,
      notes: "backlit",
    });

    const recipe = await proposeRecipe(gateway, { preview, profile });

    expect(requests[0]!.jsonSchema).toBe(PHOTO_EDIT_REPLY);
    expect(requests[0]!.json).toBe(true);
    expect(recipe).toEqual({
      version: "1.0",
      assetType: "photo",
      sourceStyleProfileId: "warm",
      adjustments: { exposure: -0.4, contrast: 12, shadows: 18, hsl: { orange: { hue: 5 } }, whiteBalance: { tempK: 5400 } },
      confidence: 0.7,
      notes: "backlit",
    });
  });

  it("lets the model switch off a setting the style has by saying 0, and still accepts the older, looser reply shape", async () => {
    const zeroed = gatewayReplying({ adjustments: { exposure: 0.3, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, vibrance: 0, saturation: 0, whiteBalance: { tempK: 6100, tint: 0 } }, confidence: 0.5, notes: "" });
    expect((await proposeRecipe(zeroed.gateway, { preview, profile })).adjustments).toMatchObject({ contrast: 0, whiteBalance: { tempK: 6100 } });

    const loose = gatewayReplying({ adjustments: { exposure: 0.9 } });
    expect((await proposeRecipe(loose.gateway, { preview, profile })).adjustments).toEqual({ ...profile.baseAdjustments, exposure: 0.9 });
  });

  it("still rejects a value out of range, so the repair loop gets a chance", async () => {
    const wild = gatewayReplying({ adjustments: { exposure: 40 } });
    await expect(proposeRecipe(wild.gateway, { preview, profile })).rejects.toMatchObject({ code: "LLM_SCHEMA_INVALID" });
    expect(wild.requests).toHaveLength(3); // the reply and two repair attempts
  });
});

describe("learnStyle with the compact reply", () => {
  it("leaves out what the photographer leaves alone", async () => {
    const { gateway, requests } = gatewayReplying({
      summary: "warm, lifted shadows",
      baseAdjustments: { exposure: 0.3, contrast: 0, highlights: -20, shadows: 25, whites: 0, blacks: 0, vibrance: 8, saturation: 0, whiteBalance: { tempK: 0, tint: 0 } },
    });
    const learned = await learnStyle(gateway, { id: "warm", name: "Warm", references: [preview] });
    expect(requests[0]!.jsonSchema).toBe(STYLE_REPLY);
    expect(learned).toEqual({ id: "warm", name: "Warm", version: 1, summary: "warm, lifted shadows", baseAdjustments: { exposure: 0.3, highlights: -20, shadows: 25, vibrance: 8 } });
  });
});

describe("a failure no other photo can get past", () => {
  const asset = (id: string): AssetRef => ({ id, kind: "photo", path: `/shoot/${id}.cr3` });
  const adapter: EditorAdapter = {
    id: "fake",
    capabilities: { mediaKinds: ["photo"], executionModel: "local-cli", requiresGuiOpen: false, os: ["windows"], supportedRecipeFields: ["exposure"] },
    detect: async () => ({}),
    applyRecipe: async (a) => ({ assetId: a.id, outputs: [] }),
  };
  const run = (failWith: (id: string) => VivahError | undefined) => {
    const calls: string[] = [];
    const gateway = new LlmGateway()
      .registerProvider({
        id: "p",
        complete: async (req) => {
          const id = ((req.messages.at(-1)!.content as { type: string; dataBase64?: string }[]).find((p) => p.type === "image")!).dataBase64!;
          calls.push(id);
          const err = failWith(id);
          if (err) throw err;
          return { text: JSON.stringify({ adjustments: { exposure: 0.2 } }) };
        },
      })
      .setRoute("vision", { providerId: "p", model: "m" });
    const store = new MemoryStore();
    const summary = runJob(
      { store, gateway, adapter, profile, concurrency: 1, previewOf: async (a) => ({ mediaType: "image/jpeg", dataBase64: a.id }) },
      { id: "j", name: "x", assets: ["a", "b", "c", "d"].map(asset) },
    );
    return { summary, calls, store };
  };

  it("stops starting new photos, leaves them waiting, and says why", async () => {
    const { summary, calls, store } = run((id) => (id === "b" ? new VivahError("LLM_QUOTA_EXCEEDED", "out of credit") : undefined));
    const result = await summary;

    expect(calls).toEqual(["a", "b"]);
    expect(result.stoppedEarly).toEqual({ code: "LLM_QUOTA_EXCEEDED", message: "out of credit" });
    expect(result.awaitingReview).toEqual(["a"]);
    expect(result.failed).toEqual([{ assetId: "b", code: "LLM_QUOTA_EXCEEDED", message: "out of credit" }]);
    expect(store.listItems("j").filter((i) => i.state === "style-matched").map((i) => i.assetId)).toEqual(["c", "d"]);
  });

  it("carries on past a problem that belongs to one photo", async () => {
    const { summary, calls } = run((id) => (id === "b" ? new VivahError("LLM_CONTENT_FILTERED", "filtered") : undefined));
    const result = await summary;
    expect(calls).toEqual(["a", "b", "c", "d"]);
    expect(result.stoppedEarly).toBeUndefined();
    expect(result.awaitingReview).toEqual(["a", "c", "d"]);
  });

  it("applies to the editor stage too: an editor version it cannot write for stops the apply, with the reason, instead of failing every photo", async () => {
    const applied: string[] = [];
    const tooOld: EditorAdapter = {
      ...adapter,
      applyRecipe: async (a) => {
        applied.push(a.id);
        throw new VivahError("ADAPTER_VERSION_UNSUPPORTED", "darktable 5.4.1 is older than 5.6");
      },
    };
    const gateway = new LlmGateway()
      .registerProvider({ id: "p", complete: async () => ({ text: JSON.stringify({ adjustments: { exposure: 0.2 } }) }) })
      .setRoute("vision", { providerId: "p", model: "m" });
    const store = new MemoryStore();
    const result = await runJob(
      { store, gateway, adapter: tooOld, profile, concurrency: 1, previewOf: async (a) => ({ mediaType: "image/jpeg", dataBase64: a.id }) },
      { id: "j", name: "x", assets: ["a", "b", "c"].map(asset) },
    );
    expect(applied).toEqual(["a"]);
    expect(result.stoppedEarly).toEqual({ code: "ADAPTER_VERSION_UNSUPPORTED", message: "darktable 5.4.1 is older than 5.6" });
    expect(result.failed.map((f) => f.assetId)).toEqual(["a"]);
    // The others keep their recipes and wait; fixing the editor and running again carries on.
    expect(store.listItems("j").filter((i) => i.state === "recipe-generated").map((i) => i.assetId).sort()).toEqual(["b", "c"]);
  });
});
