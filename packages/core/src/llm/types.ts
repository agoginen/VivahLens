export type LlmTask = "vision" | "reasoning" | "bulk";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; dataBase64: string };

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for a JSON object where supported. */
  json?: boolean;
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmResponse {
  text: string;
  usage?: LlmUsage;
}

export interface LlmProvider {
  readonly id: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export interface Route {
  providerId: string;
  model: string;
}
