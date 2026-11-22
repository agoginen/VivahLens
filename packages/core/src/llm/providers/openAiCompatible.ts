import type { ContentPart, LlmMessage, LlmProvider, LlmRequest, LlmResponse } from "../types.js";
import { VivahError } from "../../errors.js";
import { DEFAULT_TIMEOUT_MS, httpError, isLoopbackUrl, networkError, withTimeout } from "./http.js";
import { EndpointQuirks, withAdaptation, type StructuredMode } from "./quirks.js";

export interface OpenAiCompatibleOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  /** Sent as this header instead of `Authorization: Bearer` (Azure OpenAI wants `api-key`). */
  authHeader?: "authorization" | "api-key";
  /**
   * How far to push structured output on this endpoint: a schema it enforces, plain JSON mode, or nothing. It starts at
   * `json_schema` and steps down by itself when the endpoint refuses.
   */
  structuredOutput?: StructuredMode;
  fetch?: typeof fetch;
  /** Per-request timeout; slow vision models on local hardware may need more. */
  timeoutMs?: number;
}

/** Covers OpenAI, OpenRouter, Gemini's OpenAI endpoint, Ollama, LM Studio and other /chat/completions servers. */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string;
  readonly local: boolean;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly authHeader: "authorization" | "api-key";
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly quirks: EndpointQuirks;

  constructor(opts: OpenAiCompatibleOptions) {
    this.id = opts.id;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.local = isLoopbackUrl(this.baseUrl);
    this.apiKey = opts.apiKey;
    this.authHeader = opts.authHeader ?? "authorization";
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.quirks = new EndpointQuirks(opts.structuredOutput ?? "json_schema");
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    return withAdaptation(this.quirks, req, () => this.send(req));
  }

  private async send(req: LlmRequest): Promise<LlmResponse> {
    const mode = this.quirks.modeFor(req);
    const responseFormat =
      mode === "json_schema" && req.jsonSchema
        ? { type: "json_schema", json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema } }
        : mode === "json_object"
          ? { type: "json_object" }
          : undefined;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal: withTimeout(req.signal, this.timeoutMs),
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? (this.authHeader === "api-key" ? { "api-key": this.apiKey } : { authorization: `Bearer ${this.apiKey}` }) : {}),
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages.map(toOpenAiMessage),
          max_tokens: req.maxTokens,
          ...(this.quirks.sendTemperature && req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(responseFormat ? { response_format: responseFormat } : {}),
        }),
      });
    } catch (err) {
      throw networkError(this.id, err, req.signal);
    }
    if (!res.ok) throw await httpError(this.id, res);
    const body = (await res.json()) as {
      choices: { message: { content: string | null; refusal?: string | null }; finish_reason?: string }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    const choice = body.choices[0];
    if (choice?.message.refusal) throw new VivahError("LLM_REFUSED", `${this.id} declined this photo: ${choice.message.refusal.slice(0, 200)}`);
    if (choice?.finish_reason === "content_filter") throw new VivahError("LLM_CONTENT_FILTERED", `${this.id} declined this photo with its content filter`);
    const u = body.usage;
    return {
      text: choice?.message.content ?? "",
      usage: {
        inputTokens: u?.prompt_tokens,
        outputTokens: u?.completion_tokens,
        ...(u?.completion_tokens_details?.reasoning_tokens !== undefined && { reasoningTokens: u.completion_tokens_details.reasoning_tokens }),
        ...(u?.prompt_tokens_details?.cached_tokens !== undefined && { cachedInputTokens: u.prompt_tokens_details.cached_tokens }),
      },
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
