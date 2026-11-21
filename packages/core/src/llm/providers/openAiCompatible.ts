import type { ContentPart, LlmMessage, LlmProvider, LlmRequest, LlmResponse } from "../types.js";
import { httpError } from "./http.js";

export interface OpenAiCompatibleOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

/** Covers OpenAI, OpenRouter, Gemini's OpenAI endpoint, Ollama, LM Studio and other /chat/completions servers. */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiCompatibleOptions) {
    this.id = opts.id;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal: req.signal,
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages.map(toOpenAiMessage),
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (!res.ok) throw await httpError(this.id, res);
    const body = (await res.json()) as {
      choices: { message: { content: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: body.choices[0]?.message.content ?? "",
      usage: { inputTokens: body.usage?.prompt_tokens, outputTokens: body.usage?.completion_tokens },
    };
  }
}

function toOpenAiMessage(m: LlmMessage) {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  return { role: m.role, content: m.content.map(toOpenAiPart) };
}

function toOpenAiPart(p: ContentPart) {
  return p.type === "text"
    ? { type: "text", text: p.text }
    : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.dataBase64}` } };
}
