import { describe, expect, it } from "vitest";
import { formatDuration, progressPrinter } from "./progress.js";
import { buildGateway, providerNotice } from "./providers.js";

describe("progressPrinter", () => {
  it("throttles output, shows an ETA, always reports completion and restarts per stage", () => {
    const lines: string[] = [];
    let clock = 1_000_000;
    const print = progressPrinter((l) => lines.push(l), 2000, () => clock);

    print({ stage: "recipe-generated", done: 1, total: 10 });
    clock += 500;
    print({ stage: "recipe-generated", done: 2, total: 10 });
    clock += 2000;
    print({ stage: "recipe-generated", done: 5, total: 10 });
    clock += 100;
    print({ stage: "recipe-generated", done: 10, total: 10 });
    print({ stage: "review", done: 1, total: 1 });

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/Proposing edits: 1\/10 · ETA 0s/);
    expect(lines[1]).toMatch(/Proposing edits: 5\/10 · ETA 3s/);
    expect(lines[2]).toMatch(/Proposing edits: 10\/10 done in 3s/);
    expect(lines[3]).toMatch(/Applying edits: 1\/1 done in 0s/);
  });

  it("formats durations", () => {
    expect([formatDuration(4.4), formatDuration(75), formatDuration(3720)]).toEqual(["4s", "1m15s", "1h02m"]);
  });
});

describe("providers", () => {
  it("refuses Gemini until the user confirms paid billing, then needs a key", () => {
    expect(() => buildGateway({ provider: "gemini", model: "m" }, { GEMINI_API_KEY: "k" })).toThrow(/free-tier/);
    expect(() => buildGateway({ provider: "gemini", model: "m", confirmedPaidTier: true }, {})).toThrow(/GEMINI_API_KEY/);
    expect(() => buildGateway({ provider: "gemini", model: "m", confirmedPaidTier: true }, { GEMINI_API_KEY: "k" })).not.toThrow();
  });

  it("builds Azure OpenAI from a base URL and key, authenticating with the api-key header and addressing the deployment by model", async () => {
    expect(() => buildGateway({ provider: "azure", model: "my-deployment" }, { AZURE_OPENAI_API_KEY: "k" })).toThrow(/--base-url is required/);
    expect(() => buildGateway({ provider: "azure", model: "d", baseUrl: "https://r.openai.azure.com/openai/v1" }, {})).toThrow(/AZURE_OPENAI_API_KEY/);

    const seen: { url: string; key?: string; model?: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, key: (init.headers as Record<string, string>)["api-key"], model: JSON.parse(String(init.body)).model });
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const gateway = buildGateway({ provider: "azure", model: "my-deployment", baseUrl: "https://r.openai.azure.com/openai/v1/" }, { AZURE_OPENAI_API_KEY: "azure-key" });
      await gateway.complete("vision", { messages: [{ role: "user", content: "hi" }] });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toEqual([{ url: "https://r.openai.azure.com/openai/v1/chat/completions", key: "azure-key", model: "my-deployment" }]);
  });

  it("discloses data handling for hosted providers but not for local or mock ones", () => {
    expect(providerNotice("openai")).toMatch(/30 days/);
    expect(providerNotice("anthropic")).toMatch(/30 days/);
    expect(providerNotice("gemini")).toMatch(/Free-tier/);
    expect(providerNotice("azure")).toMatch(/content filter/);
    expect(providerNotice("openai-compatible")).toMatch(/not known/);
    expect(providerNotice("ollama")).toBeUndefined();
    expect(providerNotice("mock")).toBeUndefined();
  });
});
