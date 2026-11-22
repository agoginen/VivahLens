import type { ContentPart, LlmMessage, LlmProvider, LlmRequest, LlmResponse } from "../types.js";
import { VivahError } from "../../errors.js";
import { DEFAULT_TIMEOUT_MS, httpError, isLoopbackUrl, networkError, withTimeout } from "./http.js";
import { EndpointQuirks, withAdaptation } from "./quirks.js";

export interface AnthropicOptions {
  id?: string;
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class AnthropicProvider implements LlmProvider {
  readonly id: string;
  readonly local: boolean;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly quirks = new EndpointQuirks("json_schema");

  constructor(opts: AnthropicOptions) {
    this.id = opts.id ?? "anthropic";
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.local = isLoopbackUrl(this.baseUrl);
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    return withAdaptation(this.quirks, req, () => this.send(req));
  }

  private async send(req: LlmRequest): Promise<LlmResponse> {
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    // Anthropic enforces a schema natively and has no JSON mode: without one the reply is validated and repaired by the caller.
    const enforce = req.jsonSchema && this.quirks.modeFor(req) === "json_schema";
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        signal: withTimeout(req.signal, this.timeoutMs),
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens ?? 4096,
          ...(this.quirks.sendTemperature && req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(system ? { system } : {}),
          ...(enforce ? { output_config: { format: { type: "json_schema", schema: req.jsonSchema!.schema } } } : {}),
          messages: req.messages.filter((m) => m.role !== "system").map(toAnthropicMessage),
        }),
      });
    } catch (err) {
      throw networkError(this.id, err, req.signal);
    }
    if (!res.ok) throw await httpError(this.id, res);
    const body = (await res.json()) as {
      content: { type: string; text?: string }[];
      stop_reason?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        output_tokens_details?: { thinking_tokens?: number };
      };
    };
    if (body.stop_reason === "refusal") throw new VivahError("LLM_REFUSED", `${this.id} declined this photo`);
    const u = body.usage;
    // The input that was read from or written to the cache is billed too; `input_tokens` alone leaves it out.
    const input = u?.input_tokens === undefined ? undefined : u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    return {
      text: body.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join(""),
      usage: {
        inputTokens: input,
        outputTokens: u?.output_tokens,
        ...(u?.output_tokens_details?.thinking_tokens !== undefined && { reasoningTokens: u.output_tokens_details.thinking_tokens }),
        ...(u?.cache_read_input_tokens !== undefined && { cachedInputTokens: u.cache_read_input_tokens }),
      },
    };
  }
}

function toAnthropicMessage(m: LlmMessage) {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  return { role: m.role, content: m.content.map(toAnthropicPart) };
}

function toAnthropicPart(p: ContentPart) {
  return p.type === "text"
    ? { type: "text", text: p.text }
    : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.dataBase64 } };
}
