export type ErrorCode =
  | "LLM_SCHEMA_INVALID"
  | "LLM_RATE_LIMIT"
  | "LLM_AUTH"
  | "LLM_REQUEST_FAILED"
  | "LLM_NOT_CONFIGURED"
  | "ADAPTER_EDITOR_NOT_RUNNING"
  | "ADAPTER_VERSION_UNSUPPORTED"
  | "ADAPTER_APPLY_FAILED"
  | "ASSET_UNREADABLE"
  | "DISK_FULL"
  | "BUDGET_EXCEEDED"
  | "ENTITLEMENT_INVALID"
  | "ENTITLEMENT_EXPIRED";

/** Error with a stable code that the UI maps to a message and a one-click remedy. */
export class VivahError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "VivahError";
  }
}

export function errorCodeOf(err: unknown): ErrorCode | "UNKNOWN" {
  return err instanceof VivahError ? err.code : "UNKNOWN";
}
