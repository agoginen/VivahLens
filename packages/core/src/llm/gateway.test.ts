import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmGateway } from "./gateway.js";
import { VivahError } from "../errors.js";
import type { LlmProvider, LlmRequest, LlmResponse } from "./types.js";

const scripted = (replies: (LlmResponse | Error)[]): LlmProvider & { requests: LlmRequest[] } => {
  const requests: LlmRequest[] = [];
  return {
    id: "fake",
    requests,
    async complete(req) {
      requests.push(req);
      const next = replies.shift();
      if (!next) throw new Error("no scripted reply left");
      if (next instanceof Error) throw next;
      return next;
    },
  };
};

const gatewayFor = (provider: LlmProvider, opts?: ConstructorParameters<typeof LlmGateway>[0]) =>
  new LlmGateway(opts).registerProvider(provider).setRoute("vision", { providerId: "fake", model: "m" });

const schema = z.object({ n: z.number() });
const msg = { messages: [{ role: "user" as const, content: "go" }] };

describe("LlmGateway.completeJson", () => {
  it("feeds the validation error back and succeeds on the repaired reply", async () => {
    const p = scripted([{ text: '{"n":"x"}' }, { text: '```json\n{"n":2}\n```' }]);
    await expect(gatewayFor(p).completeJson("vision", msg, schema)).resolves.toEqual({ n: 2 });
    expect(JSON.stringify(p.requests[1]!.messages)).toContain("Your reply was invalid");
  });

  it("fails with LLM_SCHEMA_INVALID after two repair attempts", async () => {
    const p = scripted([{ text: "nope" }, { text: "nope" }, { text: "nope" }]);
    await expect(gatewayFor(p).completeJson("vision", msg, schema)).rejects.toMatchObject({
      code: "LLM_SCHEMA_INVALID",
    });
    expect(p.requests).toHaveLength(3);
  });
});

describe("LlmGateway spend and retries", () => {
  it("stops once the spend cap is reached", async () => {
    const p = scripted([{ text: "a", usage: { inputTokens: 1_000_000, outputTokens: 0 } }, { text: "b" }]);
    const g = gatewayFor(p, { prices: { effectiveFrom: "2026-01-01", models: { m: { inputPerMTok: 2, outputPerMTok: 0 } } }, maxCostUsd: 1 });
    await g.complete("vision", msg);
    expect(g.usage().costUsd).toBe(2);
    await expect(g.complete("vision", msg)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("retries rate-limit errors with backoff but not auth errors", async () => {
    const sleeps: number[] = [];
    const opts = { retry: { attempts: 3, baseDelayMs: 100 }, sleep: async (ms: number) => void sleeps.push(ms) };
    const limited = scripted([new VivahError("LLM_RATE_LIMIT", "429", true), { text: "ok" }]);
    await expect(gatewayFor(limited, opts).complete("vision", msg)).resolves.toMatchObject({ text: "ok" });
    expect(sleeps).toHaveLength(1);

    const denied = scripted([new VivahError("LLM_AUTH", "401"), { text: "ok" }]);
    await expect(gatewayFor(denied, opts).complete("vision", msg)).rejects.toMatchObject({ code: "LLM_AUTH" });
  });
});
