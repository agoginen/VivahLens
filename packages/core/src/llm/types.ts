export type LlmTask = "vision" | "reasoning" | "bulk";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; dataBase64: string };

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface JsonSchemaSpec {
  /** Letters, digits, `_` and `-` (OpenAI's rule for schema names). */
  name: string;
  schema: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for a JSON object where supported. */
  json?: boolean;
  /**
   * The shape the reply must have. Providers that can enforce a schema do; the rest fall back to plain JSON mode, so the
   * caller still validates what comes back.
   */
  jsonSchema?: JsonSchemaSpec;
  signal?: AbortSignal;
}

export interface LlmUsage {
  /** All input tokens, including any served from a cache. */
  inputTokens?: number;
  /** All billable output tokens, including any spent on reasoning. */
  outputTokens?: number;
  /** The part of the output that was reasoning, when the provider says so (already included in `outputTokens`). */
  reasoningTokens?: number;
  /** The part of the input that came from the provider's prompt cache. */
  cachedInputTokens?: number;
}

export interface LlmResponse {
  text: string;
  usage?: LlmUsage;
}

export interface LlmProvider {
  readonly id: string;
  /** Runs on this computer (a loopback address): nothing sent to it leaves the machine. */
  readonly local?: boolean;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export interface Route {
  providerId: string;
  model: string;
}
