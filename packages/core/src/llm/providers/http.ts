import { VivahError } from "../../errors.js";

/** The provider's own words for what went wrong, from the JSON error body shapes the vendors use. */
function errorDetails(text: string): { code: string; type: string; message: string } {
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    const e = (typeof body.error === "object" && body.error !== null ? body.error : body) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    return { code: str(e.code), type: str(e.type), message: str(e.message) || (typeof body.error === "string" ? body.error : "") };
  } catch {
    return { code: "", type: "", message: "" };
  }
}

/** Seconds, milliseconds (Azure's `retry-after-ms`) or an HTTP date, as milliseconds to wait. */
function retryAfterMs(headers: Headers): number | undefined {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.get("retry-after-ms") !== null && Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** A 429 or 402 that more waiting cannot fix: the account is out of credit or at its spend limit. */
const QUOTA = /insufficient_quota|credit_balance|spend_limit|usage_limit_exceeded|billing_error|out of credit|payment required/i;

/**
 * Maps a failed provider HTTP response to a stable error code (docs/research/llm-api-verification-2.md §6): rate limits and
 * overload are retryable and carry the provider's own wait; spend and credit limits are not, and stop the batch with a
 * clear message; a content-filter refusal belongs to one photo, not the whole batch.
 */
export async function httpError(providerId: string, res: Response): Promise<VivahError> {
  const body = await res.text().catch(() => "");
  const message = `${providerId} request failed: ${res.status} ${body.slice(0, 500)}`;
  const { code, type, message: detail } = errorDetails(body);
  const words = `${code} ${type} ${detail}`;
  if (res.status === 401 || res.status === 403) return new VivahError("LLM_AUTH", message);
  if (res.status === 402 || ((res.status === 429 || res.status === 400) && QUOTA.test(words))) {
    return new VivahError("LLM_QUOTA_EXCEEDED", `${providerId} says the account is out of credit or at its spend limit: ${detail || body.slice(0, 200)}`);
  }
  if (res.status === 400 && /content_filter|content filter|responsibleaipolicy/i.test(words)) {
    return new VivahError("LLM_CONTENT_FILTERED", `${providerId} declined this photo with its content filter: ${detail || body.slice(0, 200)}`);
  }
  if (res.status === 429 || res.status === 408 || res.status >= 500) {
    // 529 (Anthropic) and 503 (everyone else) mean overloaded, which backing off also cures.
    return new VivahError("LLM_RATE_LIMIT", message, true, retryAfterMs(res.headers));
  }
  return new VivahError("LLM_REQUEST_FAILED", message);
}

export const DEFAULT_TIMEOUT_MS = 120_000;

/** A model server on this computer (Ollama, LM Studio): what it is sent never leaves the machine. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

/** The caller's cancel signal combined with a request timeout. */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Network-level failures (offline, DNS, connection reset, timeout) are retryable: the gateway backs off and tries again,
 * and anything still failing can be resumed later with `--retry-failed`. A cancel requested by the caller is rethrown
 * untouched so Ctrl-C keeps working.
 */
export function networkError(providerId: string, err: unknown, callerSignal: AbortSignal | undefined): Error {
  if (callerSignal?.aborted) return err instanceof Error ? err : new Error(String(err));
  const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
  const cause = timedOut ? "the request timed out" : err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
  return new VivahError("LLM_REQUEST_FAILED", `${providerId} could not be reached: ${cause}`, true);
}
