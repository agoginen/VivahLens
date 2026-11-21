import type { z } from "zod";
import { VivahError } from "../errors.js";
import { costOf, type VersionedPriceTable } from "./pricing.js";
import type { LlmProvider, LlmRequest, LlmResponse, LlmTask, Route } from "./types.js";

export interface GatewayOptions {
  prices?: VersionedPriceTable;
  /** Hard spend cap in USD for this gateway's lifetime (one job). */
  maxCostUsd?: number;
  /** Attempts for retryable errors (rate limit), with exponential backoff. */
  retry?: { attempts: number; baseDelayMs: number };
  sleep?: (ms: number) => Promise<void>;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const MAX_SCHEMA_REPAIRS = 2;

/**
 * Provider-agnostic seam for every LLM call: routing by task, schema-validated JSON replies with
 * repair retries, backoff on rate limits, and a spend ledger with a hard cap.
 */
export class LlmGateway {
  private providers = new Map<string, LlmProvider>();
  private routes = new Map<LlmTask, Route>();
  private ledger: UsageSummary = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: GatewayOptions = {}) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  registerProvider(provider: LlmProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  setRoute(task: LlmTask, route: Route): this {
    this.routes.set(task, route);
    return this;
  }

  usage(): Readonly<UsageSummary> {
    return { ...this.ledger };
  }

  async complete(task: LlmTask, req: Omit<LlmRequest, "model">): Promise<LlmResponse> {
    const route = this.routes.get(task);
    if (!route) throw new VivahError("LLM_NOT_CONFIGURED", `No LLM route configured for task "${task}"`);
    const provider = this.providers.get(route.providerId);
    if (!provider) throw new VivahError("LLM_NOT_CONFIGURED", `LLM provider "${route.providerId}" is not registered`);

    const { maxCostUsd } = this.opts;
    if (maxCostUsd !== undefined && this.ledger.costUsd >= maxCostUsd) {
      throw new VivahError("BUDGET_EXCEEDED", `LLM spend cap of $${maxCostUsd} reached`);
    }

    const res = await this.withRetry(() => provider.complete({ ...req, model: route.model }));
    this.ledger.calls++;
    this.ledger.inputTokens += res.usage?.inputTokens ?? 0;
    this.ledger.outputTokens += res.usage?.outputTokens ?? 0;
    if (this.opts.prices && res.usage) {
      this.ledger.costUsd += costOf(this.opts.prices, route.model, res.usage) ?? 0;
    }
    return res;
  }

  /** Completes and validates the JSON reply against a schema, feeding the validation error back on failure. */
  async completeJson<T>(
    task: LlmTask,
    req: Omit<LlmRequest, "model" | "json">,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T> {
    let messages = req.messages;
    let lastError = "";
    for (let attempt = 0; attempt <= MAX_SCHEMA_REPAIRS; attempt++) {
      const res = await this.complete(task, { ...req, messages, json: true });
      const parsed = schema.safeParse(tryParseJson(res.text));
      if (parsed.success) return parsed.data;
      lastError = parsed.error.message;
      messages = [
        ...req.messages,
        { role: "assistant", content: res.text },
        { role: "user", content: `Your reply was invalid: ${lastError}\nReturn only corrected JSON.` },
      ];
    }
    throw new VivahError("LLM_SCHEMA_INVALID", `LLM returned invalid JSON for task "${task}": ${lastError}`);
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const { attempts, baseDelayMs } = this.opts.retry ?? { attempts: 1, baseDelayMs: 0 };
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof VivahError) || !err.retryable || i >= attempts) throw err;
        await this.sleep(baseDelayMs * 2 ** (i - 1) * (0.5 + Math.random() / 2));
      }
    }
  }
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
