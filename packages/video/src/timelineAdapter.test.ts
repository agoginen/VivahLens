import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EditRecipe } from "@vivahlens/core";
import { adapterContract } from "@vivahlens/testkit";
import { parseFps } from "./time.js";
import { TimelineFileAdapter } from "./timelineAdapter.js";
import type { ClipInfo } from "./timeline.js";
import { findAll, parseXml } from "./xmlTestUtil.js";

const dir = mkdtempSync(path.join(tmpdir(), "vivah-timeline-"));
// The contract suite removes the folder after each case, and later cases write into it again: clear it once more at the very end.
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const clips: ClipInfo[] = [
  { clipId: "A001.mp4", path: path.join(dir, "A001.mp4"), durationSec: 60, fps: parseFps(25), width: 1920, height: 1080, hasAudio: true },
  { clipId: "B002.mp4", path: path.join(dir, "B002.mp4"), durationSec: 40, fps: parseFps(25), width: 1920, height: 1080, hasAudio: true },
];
const video = (cuts: NonNullable<EditRecipe["adjustments"]["videoEdits"]>["cuts"]): EditRecipe => ({ version: "1.0", assetType: "video", adjustments: { videoEdits: { cuts } } });
const sample = video([
  { clipId: "A001.mp4", inSec: 5, outSec: 12 },
  { clipId: "B002.mp4", inSec: 20, outSec: 26, transitionIn: "crossfade" },
]);

for (const format of ["fcpxml", "edl"] as const) {
  adapterContract({
    name: `timeline-${format}`,
    create: () => ({ adapter: new TimelineFileAdapter({ format, clips }), cleanup: () => rmSync(dir, { recursive: true, force: true }) }),
    asset: () => ({ id: "reel", kind: "video", path: path.join(dir, `Highlights-${format}`) }),
    recipes: { sample, rejectsEmpty: true },
    expectApplied: (asset, outputs) => {
      expect(outputs).toEqual([`${asset.path}.${format}`]);
      expect(readFileSync(outputs[0]!, "utf8")).toContain(format === "edl" ? "TITLE: Highlights-edl" : "<fcpxml");
    },
  });
}

describe("TimelineFileAdapter", () => {
  it("writes a crossfade as a transition, and says what could not be checked without Final Cut", async () => {
    const adapter = new TimelineFileAdapter({ format: "fcpxml", clips });
    const res = await adapter.applyRecipe({ id: "r", kind: "video", path: path.join(dir, "Reel.fcpxml") }, sample);
    expect(res.outputs).toEqual([path.join(dir, "Reel.fcpxml")]);
    expect(res.warnings).toEqual(["The crossfades use Final Cut's built-in Cross Dissolve; its identifier is not in Apple's documentation, so check the transitions after importing."]);
    const root = parseXml(readFileSync(res.outputs[0]!, "utf8"));
    expect(findAll(root, "sequence")[0]!.attrs.duration).toBe("325/25s");
    expect(findAll(root, "asset-clip").map((c) => c.attrs.start)).toEqual(["125/25s", "500/25s"]);
    expect(findAll(root, "transition")).toHaveLength(1);
  });

  it("creates missing folders and keeps an existing extension", async () => {
    const adapter = new TimelineFileAdapter({ format: "edl", clips });
    const target = path.join(dir, "nested", "deeper", "cut.edl");
    const res = await adapter.applyRecipe({ id: "r", kind: "video", path: target }, sample);
    expect(res.outputs).toEqual([target]);
    expect(existsSync(target)).toBe(true);
  });

  it("explains why it cannot build a timeline", async () => {
    const adapter = new TimelineFileAdapter({ format: "edl", clips });
    const asset = { id: "r", kind: "video" as const, path: path.join(dir, "x") };
    await expect(adapter.applyRecipe(asset, video([{ clipId: "missing.mp4", inSec: 0, outSec: 2 }]))).rejects.toThrow(/unknown clip "missing.mp4"/);
    await expect(new TimelineFileAdapter({ format: "edl", clips: [] }).applyRecipe(asset, sample)).rejects.toThrow(/No clips/);
    await expect(adapter.applyRecipe({ ...asset, kind: "photo" }, sample)).rejects.toMatchObject({ code: "ADAPTER_APPLY_FAILED" });
  });
});
