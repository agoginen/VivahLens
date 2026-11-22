import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeReplacing } from "../adapters/safeWrite.js";
import { MemoryStore } from "./libraryStore.js";
import { undoJob } from "./undo.js";

const dir = mkdtempSync(path.join(tmpdir(), "vivah-undo-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What an adapter does on apply: replace the file, and have the pipeline keep what was replaced. */
async function apply(store: MemoryStore, jobId: string, assetId: string, target: string, content: string) {
  const { replaced } = await writeReplacing(target, content, { backupDir: path.join(dir, "backups", jobId) });
  if (replaced) store.recordUndo({ jobId, assetId, adapterId: "xmp-sidecar", at: new Date().toISOString(), ...replaced });
}

function jobWith(store: MemoryStore, ...assetIds: string[]) {
  store.ensureJob({ id: "j", name: "x", adapterId: "xmp-sidecar", styleProfileId: "p", createdAt: "t" });
  for (const assetId of assetIds) store.putItem({ jobId: "j", assetId, state: "review", attempts: 0, outputs: ["x"] });
}

describe("undoJob", () => {
  it("puts back what a file held before the job first changed it, however often it was rewritten", async () => {
    const store = new MemoryStore();
    jobWith(store, "a");
    const file = path.join(dir, "a.xmp");
    writeFileSync(file, "the photographer's sidecar");
    await apply(store, "j", "a", file, "first edit");
    await apply(store, "j", "a", file, "reviewer's override");

    const result = await undoJob({ store, library: store }, "j");

    expect(readFileSync(file, "utf8")).toBe("the photographer's sidecar");
    expect(result.restored).toEqual([{ assetId: "a", target: file }]);
    expect(store.listUndo("j", { pending: true })).toEqual([]);
    expect(store.listItems("j")[0]).toMatchObject({ state: "recipe-generated" });
    expect(store.listItems("j")[0]!.outputs).toBeUndefined();
    expect(store.listAudit({ jobId: "j" }).at(-1)).toMatchObject({ action: "undo", meta: { restored: 1, removed: 0, skipped: 0, forced: false } });
  });

  it("deletes a file the job created, and does nothing the second time", async () => {
    const store = new MemoryStore();
    jobWith(store, "b");
    const file = path.join(dir, "b.xmp");
    await apply(store, "j", "b", file, "new sidecar");

    const result = await undoJob({ store, library: store }, "j");
    expect(existsSync(file)).toBe(false);
    expect(result.removed).toEqual([{ assetId: "b", target: file }]);

    const again = await undoJob({ store, library: store }, "j");
    expect(again).toEqual({ restored: [], removed: [], skipped: [] });
  });

  it("leaves alone a file that was edited after VivahLens wrote it, unless told to force it", async () => {
    const store = new MemoryStore();
    jobWith(store, "c");
    const file = path.join(dir, "c.xmp");
    writeFileSync(file, "original");
    await apply(store, "j", "c", file, "vivah edit");
    writeFileSync(file, "vivah edit, then the photographer kept working in Lightroom");

    const careful = await undoJob({ store, library: store }, "j");
    expect(careful.skipped).toEqual([{ assetId: "c", target: file, reason: expect.stringContaining("--force") }]);
    expect(readFileSync(file, "utf8")).toContain("kept working");
    expect(store.listItems("j")[0]!.state).toBe("review");
    expect(store.listUndo("j", { pending: true })).toHaveLength(1);

    const forced = await undoJob({ store, library: store }, "j", { force: true });
    expect(forced.restored).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  it("changes nothing on a dry run, and honours a list of photos", async () => {
    const store = new MemoryStore();
    jobWith(store, "d", "e");
    const [d, e] = [path.join(dir, "d.xmp"), path.join(dir, "e.xmp")];
    writeFileSync(d, "d0");
    writeFileSync(e, "e0");
    await apply(store, "j", "d", d, "d1");
    await apply(store, "j", "e", e, "e1");

    const dry = await undoJob({ store, library: store }, "j", { dryRun: true });
    expect(dry.restored.map((r) => r.assetId).sort()).toEqual(["d", "e"]);
    expect([readFileSync(d, "utf8"), readFileSync(e, "utf8")]).toEqual(["d1", "e1"]);
    expect(store.listUndo("j", { pending: true })).toHaveLength(2);

    await undoJob({ store, library: store }, "j", { assetIds: ["d"] });
    expect([readFileSync(d, "utf8"), readFileSync(e, "utf8")]).toEqual(["d0", "e1"]);
    expect(store.listItems("j").map((i) => [i.assetId, i.state])).toEqual([["d", "recipe-generated"], ["e", "review"]]);
  });

  it("reports a missing backup rather than guessing, and leaves exported photos where they are", async () => {
    const store = new MemoryStore();
    jobWith(store, "f");
    store.putItem({ ...store.listItems("j")[0]!, state: "exported", exportedFile: "/out/f.jpg" });
    const file = path.join(dir, "f.xmp");
    writeFileSync(file, "orig");
    await apply(store, "j", "f", file, "edit");
    rmSync(store.listUndo("j")[0]!.backup!);

    const result = await undoJob({ store, library: store }, "j");

    expect(result.skipped).toEqual([{ assetId: "f", target: file, reason: expect.stringContaining("missing") }]);
    expect(readFileSync(file, "utf8")).toBe("edit");
    expect(store.listItems("j")[0]!.state).toBe("exported");
  });
});
