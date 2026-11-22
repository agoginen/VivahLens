import { VivahError } from "../../errors.js";
import type { LlmRequest } from "../types.js";

export type StructuredMode = "json_schema" | "json_object" | "none";

/**
 * What a particular endpoint accepts, learned rather than assumed. Newer models reject `temperature`, and
 * OpenAI-compatible servers differ in whether they enforce a schema, only produce JSON, or reject `response_format`
 * altogether (docs/research/llm-api-verification-2.md §1). The first 400 that names a parameter switches it off for this
 * provider and the request is sent again, so nothing needs a per-model table that goes stale.
 */
export class EndpointQuirks {
  sendTemperature = true;

  constructor(public structured: StructuredMode) {}

  /** The strongest structured-output mode that can honour what the request asks for. */
  modeFor(req: Pick<LlmRequest, "json" | "jsonSchema">): StructuredMode {
    if (!req.json && !req.jsonSchema) return "none";
    if (req.jsonSchema && this.structured === "json_schema") return "json_schema";
    return this.structured === "none" ? "none" : "json_object";
  }

  /** True when `err` says a parameter was refused and the request should be sent again without it. */
  adaptTo(err: unknown, req: LlmRequest): boolean {
    if (!(err instanceof VivahError) || err.code !== "LLM_REQUEST_FAILED") return false;
    if (this.sendTemperature && req.temperature !== undefined && /temperature/i.test(err.message)) {
      this.sendTemperature = false;
      return true;
    }
    if (this.structured !== "none" && (req.json || req.jsonSchema) && /response_format|json_schema|output_config|structured|schema/i.test(err.message)) {
      this.structured = this.structured === "json_schema" ? "json_object" : "none";
      return true;
    }
    return false;
  }
}

/** Sends the request, and sends it again (at most twice) after the endpoint refuses a parameter we can do without. */
export async function withAdaptation<T>(quirks: EndpointQuirks, req: LlmRequest, send: () => Promise<T>): Promise<T> {
  for (let adapted = 0; ; adapted++) {
    try {
      return await send();
    } catch (err) {
      if (adapted >= 2 || !quirks.adaptTo(err, req)) throw err;
    }
  }
}
