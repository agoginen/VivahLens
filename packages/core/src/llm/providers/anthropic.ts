import type { ContentPart, LlmMessage, LlmProvider, LlmRequest, LlmResponse } from "../types.js";
import { httpError } from "./http.js";

export interface AnthropicOptions {
  id?: string;
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class AnthropicProvider implements LlmProvider {
  readonly id: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AnthropicOptions) {
    this.id = opts.id ?? "anthropic";
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      signal: req.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature,
        ...(system ? { system } : {}),
        messages: req.messages.filter((m) => m.role !== "system").map(toAnthropicMessage),
      }),
    });
    if (!res.ok) throw await httpError(this.id, res);
    const body = (await res.json()) as {
      content: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      text: body.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join(""),
      usage: { inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens },
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
