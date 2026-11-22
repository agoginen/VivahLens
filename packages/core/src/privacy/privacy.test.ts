import { describe, expect, it } from "vitest";
import { VivahError } from "../errors.js";
import { LlmGateway } from "../llm/gateway.js";
import { OpenAiCompatibleProvider } from "../llm/providers/openAiCompatible.js";
import { isLoopbackUrl } from "../llm/providers/http.js";
import type { LlmProvider } from "../llm/types.js";
import { describeBase64Image, imageDimensions } from "./imageInfo.js";
import { summarizeOutbound, type OutboundEvent } from "./outbound.js";

/** Just enough of a JPEG for a reader of headers: SOI, a JFIF segment, then a baseline frame header. */
function jpegHeader(width: number, height: number, extra = 0): Buffer {
  const jfif = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.set([0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01], 9);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, sof, Buffer.alloc(extra, 7)]);
}

function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

describe("imageDimensions", () => {
  it("reads the size of a JPEG and a PNG from the header alone", () => {
    expect(imageDimensions(jpegHeader(2048, 1365))).toEqual({ width: 2048, height: 1365 });
    expect(imageDimensions(pngHeader(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it("skips over other segments to find the frame header, and gives up on anything it cannot read", () => {
    const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x0a]), Buffer.alloc(8, 1)]);
    const jpeg = jpegHeader(640, 480);
    expect(imageDimensions(Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]))).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(Buffer.from("not an image"))).toBeUndefined();
    expect(imageDimensions(jpegHeader(10, 10).subarray(0, 12))).toBeUndefined();
    expect(imageDimensions(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("describeBase64Image", () => {
  it("reports the encoded size and longest edge without decoding the whole image", () => {
    const image = jpegHeader(1536, 1024, 300_000);
    expect(describeBase64Image(image.toString("base64"))).toEqual({ bytes: image.length, maxEdgePx: 1536 });
  });

  it("still reports the size when the format is not understood", () => {
    expect(describeBase64Image(Buffer.from("opaque bytes").toString("base64"))).toEqual({ bytes: 12 });
  });
});

describe("the outbound ledger in the gateway", () => {
  const photo = jpegHeader(2048, 1365, 1000).toString("base64");
  const small = jpegHeader(512, 340, 1000).toString("base64");
  const request = {
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "edit these" }, { type: "image" as const, mediaType: "image/jpeg", dataBase64: photo }, { type: "image" as const, mediaType: "image/jpeg", dataBase64: small }] }],
  };

  function setup(provider: Partial<LlmProvider> & Pick<LlmProvider, "complete">, retry = 1) {
    const events: Omit<OutboundEvent, "jobId">[] = [];
    const gateway = new LlmGateway({ onTransfer: (e) => events.push(e), retry: { attempts: retry, baseDelayMs: 0 }, sleep: async () => undefined })
      .registerProvider({ id: "p", ...provider })
      .setRoute("vision", { providerId: "p", model: "m" });
    return { gateway, events };
  }

  it("records how many images went, how big, to whom and why, and never what they contained", async () => {
    const { gateway, events } = setup({ complete: async () => ({ text: "ok", usage: { inputTokens: 900, outputTokens: 40 } }) });

    await gateway.complete("vision", { ...request, purpose: "recipe" });

    expect(events).toEqual([
      {
        at: expect.any(String),
        provider: "p",
        model: "m",
        purpose: "recipe",
        images: 2,
        imageBytes: Buffer.from(photo, "base64").length + Buffer.from(small, "base64").length,
        maxEdgePx: 2048,
        inputTokens: 900,
        outputTokens: 40,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(photo.slice(0, 40));
  });

  it("counts a request that failed after being sent, once per attempt, and nothing for one refused before it was sent", async () => {
    let attempts = 0;
    const flaky = setup(
      {
        complete: async () => {
          if (++attempts < 3) throw new VivahError("LLM_RATE_LIMIT", "slow down", true);
          return { text: "ok" };
        },
      },
      3,
    );
    await flaky.gateway.complete("vision", request);
    expect(flaky.events.map((e) => e.failed === true)).toEqual([true, true, false]);
    expect(flaky.events.every((e) => e.purpose === "other" && e.images === 2)).toBe(true);

    const unconfigured = setup({
      complete: async () => {
        throw new VivahError("LLM_NOT_CONFIGURED", "no key");
      },
    });
    await expect(unconfigured.gateway.complete("vision", request)).rejects.toMatchObject({ code: "LLM_NOT_CONFIGURED" });
    expect(unconfigured.events).toEqual([]);
  });

  it("marks what went to a model on this computer, and carries the purpose through JSON completions", async () => {
    const { gateway, events } = setup({ local: true, complete: async () => ({ text: '{"n":1}' }) });
    const { z } = await import("zod");

    await gateway.completeJson("vision", { ...request, purpose: "style-learning" }, z.object({ n: z.number() }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ purpose: "style-learning", local: true });
  });

  it("keeps working, and reports nothing, when nobody is listening", async () => {
    const gateway = new LlmGateway().registerProvider({ id: "p", complete: async () => ({ text: "ok" }) }).setRoute("vision", { providerId: "p", model: "m" });
    await expect(gateway.complete("vision", request)).resolves.toMatchObject({ text: "ok" });
  });
});

describe("providers that run on this computer", () => {
  it("are recognised by a loopback address, and a look-alike host is not one", () => {
    for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080", "http://127.5.5.5/v1"]) expect(isLoopbackUrl(url), url).toBe(true);
    for (const url of ["https://api.openai.com/v1", "http://localhost.evil.com/v1", "http://192.168.1.20:11434/v1", "not a url"]) expect(isLoopbackUrl(url), url).toBe(false);
    expect(new OpenAiCompatibleProvider({ id: "ollama", baseUrl: "http://localhost:11434/v1" }).local).toBe(true);
    expect(new OpenAiCompatibleProvider({ id: "openai", baseUrl: "https://api.openai.com/v1" }).local).toBe(false);
  });
});

describe("summarizeOutbound", () => {
  const event = (over: Partial<OutboundEvent>): OutboundEvent => ({ at: "t", provider: "openai", purpose: "recipe", images: 1, imageBytes: 1_000_000, maxEdgePx: 2048, inputTokens: 100, outputTokens: 10, ...over });

  it("totals what left the computer, per provider and purpose, and does not count what stayed on it", () => {
    const summary = summarizeOutbound([
      event({}),
      event({ purpose: "style-learning", images: 10, imageBytes: 5_000_000, maxEdgePx: 1024 }),
      event({ failed: true, inputTokens: undefined, outputTokens: undefined }),
      event({ provider: "ollama", local: true, images: 4, imageBytes: 4_000_000 }),
    ]);

    expect(summary.totals).toMatchObject({ calls: 3, failedCalls: 1, images: 12, imageBytes: 7_000_000, inputTokens: 200, outputTokens: 20, maxEdgePx: 2048, fullResolutionCalls: 0 });
    expect(summary.providers.map((p) => [p.provider, p.local, p.calls, p.purposes])).toEqual([
      ["openai", false, 3, { recipe: 2, "style-learning": 1 }],
      ["ollama", true, 1, { recipe: 1 }],
    ]);
  });

  it("notes full-resolution sends, and is empty when nothing was sent", () => {
    expect(summarizeOutbound([event({ fullResolution: true, maxEdgePx: 6000 })]).totals).toMatchObject({ fullResolutionCalls: 1, maxEdgePx: 6000 });
    expect(summarizeOutbound([])).toEqual({ totals: expect.objectContaining({ calls: 0, images: 0 }), providers: [] });
  });
});
