import { VivahError } from "../../errors.js";

/** Maps a failed provider HTTP response to a stable error code. */
export async function httpError(providerId: string, res: Response): Promise<VivahError> {
  const body = await res.text().catch(() => "");
  const message = `${providerId} request failed: ${res.status} ${body.slice(0, 500)}`;
  if (res.status === 401 || res.status === 403) return new VivahError("LLM_AUTH", message);
  if (res.status === 429 || res.status >= 500) return new VivahError("LLM_RATE_LIMIT", message, true);
  return new VivahError("LLM_REQUEST_FAILED", message);
}
