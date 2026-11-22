import type { z } from "zod";
import { errorCodeOf, VivahError } from "../errors.js";
import { describeBase64Image } from "../privacy/imageInfo.js";
import type { OutboundEvent } from "../privacy/outbound.js";
import { costOf, type VersionedPriceTable } from "./pricing.js";
import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmTask, LlmUsage, Route } from "./types.js";

export interface GatewayOptions {
  prices?: VersionedPriceTable;
  /** Hard spend cap in USD for this gateway's lifetime (one job). */
  maxCostUsd?: number;
  /** Attempts for retryable errors (rate limit), with exponential backoff. */
  retry?: { attempts: number; baseDelayMs: number };
  sleep?: (ms: number) => Promise<void>;
  /**
   * Told about every request sent to a provider, with metadata only (how many images, how big, which provider, what
   * for): the app's "what leaves your device" ledger. Called for failed attempts too, since their images were sent.
   */
  onTransfer?(event: Omit<OutboundEvent, "jobId">): void;
  /**
   * Told about every attempt at a provider call with how long it took and how it ended: for the structured log
   * (plan §7.6). Metadata only; the request and the reply are not passed.
   */
  onCall?(event: LlmCallEvent): void;
}

export interface LlmCallEvent {
  provider: string;
  model: string;
  purpose: string;
  latencyMs: number;
  outcome: "ok" | "failed";
  /** The error's stable code when the attempt failed. */
  errorCode?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Cost of this attempt from the price table, when the model is in it. */
  costUsd?: number;
}

/** What a request is for, shown in the privacy ledger. */
export type TransferPurpose = OutboundEvent["purpose"];

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const MAX_SCHEMA_REPAIRS = 2;

function describeSent(messages: readonly LlmMessage[]): Pick<OutboundEvent, "images" | "imageBytes" | "maxEdgePx"> {
  let images = 0;
  let imageBytes = 0;
  let maxEdgePx: number | undefined;
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const part of m.content) {
      if (part.type !== "image") continue;
      const info = describeBase64Image(part.dataBase64);
      images++;
      imageBytes += info.bytes;
      if (info.maxEdgePx !== undefined) maxEdgePx = Math.max(maxEdgePx ?? 0, info.maxEdgePx);
    }
  }
  return { images, imageBytes, ...(maxEdgePx !== undefined && { maxEdgePx }) };
}

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

  async complete(task: LlmTask, req: Omit<LlmRequest, "model"> & { purpose?: TransferPurpose }): Promise<LlmResponse> {
    const route = this.routes.get(task);
    if (!route) throw new VivahError("LLM_NOT_CONFIGURED", `No LLM route configured for task "${task}"`);
    const provider = this.providers.get(route.providerId);
    if (!provider) throw new VivahError("LLM_NOT_CONFIGURED", `LLM provider "${route.providerId}" is not registered`);

    const { maxCostUsd } = this.opts;
    if (maxCostUsd !== undefined && this.ledger.costUsd >= maxCostUsd) {
      throw new VivahError("BUDGET_EXCEEDED", `LLM spend cap of $${maxCostUsd} reached`);
    }

    const { purpose, ...request } = req;
    const sent = this.opts.onTransfer ? describeSent(request.messages) : undefined;
    const report = (usage: LlmUsage | undefined, failed: boolean) =>
      this.opts.onTransfer?.({
        at: new Date().toISOString(),
        provider: provider.id,
        model: route.model,
        purpose: purpose ?? "other",
        ...sent!,
        ...(usage?.inputTokens !== undefined && { inputTokens: usage.inputTokens }),
        ...(usage?.outputTokens !== undefined && { outputTokens: usage.outputTokens }),
        ...(failed && { failed: true }),
        ...(provider.local && { local: true }),
      });

    const res = await this.withRetry(async () => {
      const started = performance.now();
      const called = (outcome: LlmCallEvent["outcome"], usage: LlmUsage | undefined, err?: unknown) => {
        if (!this.opts.onCall) return;
        const cost = this.opts.prices && usage ? costOf(this.opts.prices, route.model, usage) : undefined;
        this.opts.onCall({
          provider: provider.id,
          model: route.model,
          purpose: purpose ?? "other",
          latencyMs: Math.round(performance.now() - started),
          outcome,
          ...(err !== undefined && { errorCode: errorCodeOf(err) }),
          ...(usage?.inputTokens !== undefined && { inputTokens: usage.inputTokens }),
          ...(usage?.outputTokens !== undefined && { outputTokens: usage.outputTokens }),
          ...(cost !== undefined && { costUsd: cost }),
        });
      };
      try {
        const reply = await provider.complete({ ...request, model: route.model });
        report(reply.usage, false);
        called("ok", reply.usage);
        return reply;
      } catch (err) {
        // A request refused before it was sent (not configured) carried nothing; any other failure may have.
        if (!(err instanceof VivahError && err.code === "LLM_NOT_CONFIGURED")) report(undefined, true);
        called("failed", undefined, err);
        throw err;
      }
    });
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
    req: Omit<LlmRequest, "model" | "json"> & { purpose?: TransferPurpose },
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
        // A provider asking for minutes of silence is not worth hanging a batch for: stop and let the photo be retried later.
        if (err.retryAfterMs !== undefined && err.retryAfterMs > MAX_RETRY_WAIT_MS) throw err;
        await this.sleep(Math.max(baseDelayMs * 2 ** (i - 1) * (0.5 + Math.random() / 2), err.retryAfterMs ?? 0));
      }
    }
  }
}

/** The longest wait a provider's `Retry-After` is honoured for. */
const MAX_RETRY_WAIT_MS = 120_000;

function tryParseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
