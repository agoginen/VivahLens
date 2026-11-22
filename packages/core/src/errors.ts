export type ErrorCode =
  | "LLM_SCHEMA_INVALID"
  | "LLM_RATE_LIMIT"
  | "LLM_AUTH"
  | "LLM_REQUEST_FAILED"
  | "LLM_NOT_CONFIGURED"
  | "ADAPTER_EDITOR_NOT_RUNNING"
  | "ADAPTER_VERSION_UNSUPPORTED"
  | "ADAPTER_APPLY_FAILED"
  | "EXPORT_FINISH_FAILED"
  | "DELIVERY_FAILED"
  | "ADAPTER_CANCELLED"
  | "RECIPE_UNREADABLE"
  | "LLM_QUOTA_EXCEEDED"
  | "LLM_CONTENT_FILTERED"
  | "LLM_REFUSED"
  | "ASSET_UNREADABLE"
  | "DISK_FULL"
  | "FILE_PROTECTION_FAILED"
  | "SECRET_STORE_UNAVAILABLE"
  | "BUDGET_EXCEEDED"
  | "ENTITLEMENT_INVALID"
  | "ENTITLEMENT_EXPIRED"
  | "ENTITLEMENT_LIMIT"
  | "SIGNED_DOCUMENT_INVALID";

/** Error with a stable code that the UI maps to a message and a one-click remedy. */
export class VivahError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    /** How long the provider asked callers to wait before trying again, when it said. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "VivahError";
  }
}

/**
 * Errors that no other photo in the batch can get past: the account, the key, the budget or the installed editor's version,
 * not the photo.
 */
export const BATCH_FATAL: ReadonlySet<ErrorCode | "UNKNOWN"> = new Set<ErrorCode>(["LLM_AUTH", "LLM_QUOTA_EXCEEDED", "BUDGET_EXCEEDED", "LLM_NOT_CONFIGURED", "ADAPTER_VERSION_UNSUPPORTED"]);

export function errorCodeOf(err: unknown): ErrorCode | "UNKNOWN" {
  return err instanceof VivahError ? err.code : "UNKNOWN";
}
