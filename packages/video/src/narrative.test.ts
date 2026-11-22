import { describe, expect, it } from "vitest";
import { LlmGateway, VivahError, type LlmProvider } from "@vivahlens/core";
import { orderByNarrative, type NarrativeShot } from "./narrative.js";
import { choosePicks, layoutPicks, planRoughCut } from "./roughCut.js";
import type { ClipFeatures } from "./highlights.js";

const shot = (i: number): NarrativeShot => ({
  pick: { clipId: `c${i}.mp4`, availableIn: 0, availableOut: 6, score: 0.5, order: i },
  thumbnail: { mediaType: "image/jpeg", dataBase64: `thumb${i}` },
});

function gatewayReplying(reply: unknown | Error) {
  const seen: string[] = [];
  const provider: LlmProvider = {
    id: "fake",
    async complete(req) {
      seen.push(JSON.stringify(req.messages));
      if (reply instanceof Error) throw reply;
      return { text: typeof reply === "string" ? reply : JSON.stringify(reply) };
    },
  };
  return { gateway: new LlmGateway().registerProvider(provider).setRoute("vision", { providerId: "fake", model: "m" }), seen };
}

describe("orderByNarrative", () => {
  const shots = [0, 1, 2, 3].map(shot);

  it("applies a valid permutation and returns a label per original shot", async () => {
    const { gateway, seen } = gatewayReplying({ order: [2, 0, 3, 1], labels: ["getting ready", "ceremony", "portraits", "dance"] });
    const r = await orderByNarrative(gateway, shots);
    expect(r.usedLlm).toBe(true);
    expect(r.picks.map((p) => p.clipId)).toEqual(["c2.mp4", "c0.mp4", "c3.mp4", "c1.mp4"]);
    expect(r.labels).toEqual(["getting ready", "ceremony", "portraits", "dance"]);
    // Every shot's thumbnail was sent, labelled by index; the instructions demand an exact permutation.
    expect(seen[0]).toContain("Shot 3");
    expect(seen[0]).toContain("thumb2");
    expect(seen[0]).toContain("exactly once");
  });

  it.each([
    ["duplicate indices", { order: [0, 0, 1, 2], labels: [] }],
    ["out-of-range index", { order: [0, 1, 2, 9], labels: [] }],
    ["wrong length", { order: [0, 1, 2], labels: [] }],
  ])("keeps capture order when the model returns %s", async (_name, reply) => {
    const r = await orderByNarrative(gatewayReplying(reply).gateway, shots);
    expect(r.usedLlm).toBe(false);
    expect(r.picks.map((p) => p.clipId)).toEqual(shots.map((s) => s.pick.clipId));
    expect(r.warnings[0]).toMatch(/valid permutation/);
  });

  it("keeps capture order when the model fails or returns garbage, and for too few or too many shots", async () => {
    const failed = await orderByNarrative(gatewayReplying(new VivahError("LLM_AUTH", "denied")).gateway, shots);
    expect(failed).toMatchObject({ usedLlm: false });
    expect(failed.warnings[0]).toMatch(/failed/);

    expect((await orderByNarrative(gatewayReplying("not json at all").gateway, shots)).usedLlm).toBe(false);

    const tooFew = await orderByNarrative(gatewayReplying({ order: [0], labels: [] }).gateway, [shot(0), shot(1)]);
    expect(tooFew.warnings[0]).toMatch(/Too few/);
    const tooMany = await orderByNarrative(gatewayReplying({ order: [], labels: [] }).gateway, Array.from({ length: 41 }, (_, i) => shot(i)));
    expect(tooMany.warnings[0]).toMatch(/More than 40/);
  });
});

describe("choosePicks / layoutPicks", () => {
  const fps = 2;
  const clip = (id: string, order: number): ClipFeatures => ({
    clipId: id,
    durationSec: 40,
    sampleFps: fps,
    motion: Array.from({ length: 79 }, () => 0.05),
    sharpness: Array.from({ length: 80 }, () => 100),
    audio: { hopSec: 0.1, level: Array.from({ length: 400 }, () => 0.3) },
    order,
  });
  const clips = [clip("a.mp4", 0), clip("b.mp4", 1), clip("c.mp4", 2)];

  it("planRoughCut is exactly choose-then-layout, so reordering picks in between works", () => {
    const direct = planRoughCut(clips, { targetSec: 24 });
    const { picks, warnings } = choosePicks(clips, { targetSec: 24 });
    expect(layoutPicks(picks, { targetSec: 24 }, warnings)).toEqual(direct);

    const reversed = layoutPicks([...picks].reverse(), { targetSec: 24 }, warnings);
    expect(reversed.cuts.map((c) => c.clipId)).toEqual([...direct.cuts.map((c) => c.clipId)].reverse());
    expect(reversed.totalSec).toBeCloseTo(direct.totalSec);
  });
});
