import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EditRecipe } from "../recipe/editRecipe.js";
import type { StyleProfile } from "../style/styleProfile.js";
import { MemoryStore, type RecipeRecord, type Store } from "./libraryStore.js";
import { LATEST_SCHEMA_VERSION, SqliteStore } from "./sqliteStore.js";

const dir = mkdtempSync(path.join(tmpdir(), "vivah-store-"));
const opened: SqliteStore[] = [];
afterAll(() => {
  // Windows cannot delete a database file that is still open.
  for (const s of opened) s.close();
  rmSync(dir, { recursive: true, force: true });
});

const profile = (version: number, exposure: number): StyleProfile => ({ id: "warm", name: "Warm", version, summary: "", baseAdjustments: { exposure } });

describe.each<[string, () => Store]>([
  ["MemoryStore", () => new MemoryStore()],
  [
    "SqliteStore",
    () => {
      const s = new SqliteStore(path.join(dir, `${Math.random().toString(36).slice(2)}.db`));
      opened.push(s);
      return s;
    },
  ],
])("%s library behaviour", (_name, make) => {
  it("finds files by fingerprint across jobs and ignores repeats of the same path", () => {
    const s = make();
    const a = { path: "/a/IMG_1.CR3", fingerprint: "f1", exif: { iso: 400 }, firstSeenJob: "j1", firstSeenAt: "2026-01-01T00:00:00Z" };
    s.putAsset(a);
    s.putAsset(a);
    s.putAsset({ ...a, path: "/backup/IMG_1.CR3", firstSeenJob: "j2" });
    expect(s.findAssetsByFingerprint("f1").map((x) => [x.path, x.firstSeenJob])).toEqual([
      ["/a/IMG_1.CR3", "j1"],
      ["/backup/IMG_1.CR3", "j2"],
    ]);
    expect(s.findAssetsByFingerprint("f1")[0]!.exif).toEqual({ iso: 400 });
    expect(s.findAssetsByFingerprint("nope")).toEqual([]);
  });

  it("keeps a metadata-only audit trail per job in order", () => {
    const s = make();
    s.appendAudit({ at: "t1", action: "job-started", jobId: "j1", meta: { photos: 3 } });
    s.appendAudit({ at: "t2", action: "job-started", jobId: "j2" });
    s.appendAudit({ at: "t3", action: "review-decision", jobId: "j1" });
    expect(s.listAudit({ jobId: "j1" }).map((e) => e.action)).toEqual(["job-started", "review-decision"]);
    expect(s.listAudit({ jobId: "j1" })[0]!.meta).toEqual({ photos: 3 });
    expect(s.listAudit()).toHaveLength(3);
  });

  it("records reviewer overrides and keeps immutable style-profile versions", () => {
    const s = make();
    s.recordOverrides([
      { jobId: "j1", assetId: "a", path: "exposure", oldValue: 0.5, newValue: 1, at: "t" },
      { jobId: "j1", assetId: "b", path: "contrast", newValue: 20, at: "t" },
      { jobId: "j2", assetId: "c", path: "exposure", newValue: 2, at: "t" },
    ]);
    expect(s.listOverrides("j1").map((o) => [o.assetId, o.path, o.oldValue, o.newValue])).toEqual([
      ["a", "exposure", 0.5, 1],
      ["b", "contrast", undefined, 20],
    ]);

    s.saveProfile(profile(1, 0));
    s.saveProfile(profile(2, 0.2));
    s.saveProfile(profile(1, 99));
    expect(s.loadProfile("warm")!.version).toBe(2);
    expect(s.loadProfile("warm", 1)!.baseAdjustments.exposure).toBe(0);
    expect(s.loadProfile("missing")).toBeUndefined();
  });

  it("remembers recipes per file: the model's only for the style version it was made under, the reviewer's for any", () => {
    const s = make();
    const recipe = (exposure: number): EditRecipe => ({ version: "1.0", assetType: "photo", adjustments: { exposure } });
    const record = (over: Partial<RecipeRecord>): RecipeRecord => ({
      hash: "h",
      fingerprint: "f1",
      profileId: "warm",
      profileVersion: 1,
      recipe: recipe(0.1),
      source: "llm",
      jobId: "j1",
      assetId: "a",
      createdAt: "2026-01-01T00:00:00Z",
      ...over,
    });
    expect(s.findRecipe("f1", "warm", 1)).toBeUndefined();

    s.putRecipe(record({ recipe: recipe(0.1), confidence: 0.8 }));
    s.putRecipe(record({ recipe: recipe(0.2), createdAt: "2026-01-02T00:00:00Z" }));
    expect(s.findRecipe("f1", "warm", 1)!.recipe.adjustments.exposure).toBe(0.2);
    expect(s.findRecipe("f1", "warm", 1)!.source).toBe("llm");
    expect(s.findRecipe("f1", "warm", 2)).toBeUndefined();
    expect(s.findRecipe("f1", "other", 1)).toBeUndefined();
    expect(s.findRecipe("f2", "warm", 1)).toBeUndefined();

    s.putRecipe(record({ source: "override", recipe: recipe(-1), profileVersion: 1, createdAt: "2026-01-03T00:00:00Z" }));
    expect(s.findRecipe("f1", "warm", 1)!.recipe.adjustments.exposure).toBe(-1);
    expect(s.findRecipe("f1", "warm", 7)!.source).toBe("override");
  });

  it("logs what each apply replaced and lets entries be marked undone", () => {
    const s = make();
    const entry = { jobId: "j1", assetId: "a", adapterId: "xmp", target: "/p/a.xmp", at: "2026-01-01T00:00:00Z" };
    s.recordUndo({ ...entry, backup: "/b/a.xmp" });
    s.recordUndo({ ...entry, assetId: "b", target: "/p/b.xmp" });
    s.recordUndo({ ...entry, jobId: "j2" });

    const all = s.listUndo("j1");
    expect(all.map((u) => [u.assetId, u.backup])).toEqual([["b", undefined], ["a", "/b/a.xmp"]]); // newest first
    expect(all.every((u) => typeof u.id === "number")).toBe(true);

    s.markUndone(all[1]!.id!, "2026-01-05T00:00:00Z");
    expect(s.listUndo("j1", { pending: true }).map((u) => u.assetId)).toEqual(["b"]);
    expect(s.listUndo("j1").find((u) => u.assetId === "a")!.undoneAt).toBe("2026-01-05T00:00:00Z");
  });

  it("keeps a ledger of what was sent to model providers and where finished photos went", () => {
    const s = make();
    s.recordOutbound({ at: "t1", jobId: "j1", provider: "openai", model: "gpt", purpose: "recipe", images: 3, imageBytes: 900, maxEdgePx: 1536, inputTokens: 2000, outputTokens: 50 });
    s.recordOutbound({ at: "t2", provider: "anthropic", purpose: "style-learning", images: 10, imageBytes: 5000, fullResolution: true });
    expect(s.listOutbound({ jobId: "j1" })).toEqual([
      { at: "t1", jobId: "j1", provider: "openai", model: "gpt", purpose: "recipe", images: 3, imageBytes: 900, maxEdgePx: 1536, inputTokens: 2000, outputTokens: 50 },
    ]);
    expect(s.listOutbound().map((e) => [e.provider, e.fullResolution])).toEqual([["openai", undefined], ["anthropic", true]]);

    s.recordDelivery({ jobId: "j1", assetId: "a", destination: "sftp://host/a.jpg", at: "t3", bytes: 123 });
    s.recordDelivery({ jobId: "j1", assetId: "b", destination: "/client/b.jpg", at: "t4" });
    s.recordDelivery({ jobId: "j2", assetId: "c", destination: "/client/c.jpg", at: "t5" });
    expect(s.listDeliveries("j1")).toEqual([
      { jobId: "j1", assetId: "a", destination: "sftp://host/a.jpg", at: "t3", bytes: 123 },
      { jobId: "j1", assetId: "b", destination: "/client/b.jpg", at: "t4" },
    ]);
  });
});

describe("SqliteStore recipes from other versions", () => {
  const recipeFromTheFuture = { version: "9.9", assetType: "photo", adjustments: {} } as unknown as EditRecipe;

  it("shows one photo whose recipe this app cannot read as failed, and leaves the rest of the job readable", () => {
    const s = new SqliteStore(path.join(dir, "future-recipe.db"));
    opened.push(s);
    s.putItem({ jobId: "j", assetId: "ok", state: "review", attempts: 0, recipe: { version: "1.0", assetType: "photo", adjustments: { exposure: 1 } } });
    s.putItem({ jobId: "j", assetId: "new", state: "review", attempts: 0, recipe: recipeFromTheFuture });

    const items = s.listItems("j");
    expect(items.find((i) => i.assetId === "ok")!.state).toBe("review");
    expect(items.find((i) => i.assetId === "new")).toMatchObject({ state: "failed", failedFrom: "review", errorCode: "RECIPE_UNREADABLE", errorMessage: expect.stringContaining("update the app") });
    expect(items.find((i) => i.assetId === "new")!.recipe).toBeUndefined();
  });

  it("does not offer a stored recipe it can no longer read as a cached answer", () => {
    const s = new SqliteStore(path.join(dir, "future-cache.db"));
    opened.push(s);
    s.putRecipe({ hash: "h", fingerprint: "f", profileId: "warm", profileVersion: 1, recipe: recipeFromTheFuture, source: "llm", jobId: "j", assetId: "a", createdAt: "2026-01-01T00:00:00Z" });
    expect(s.findRecipe("f", "warm", 1)).toBeUndefined();
  });
});

describe("SqliteStore migrations", () => {
  it("upgrades a database created before the library tables existed without losing job data", async () => {
    const file = path.join(dir, "legacy.db");
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE job (id TEXT PRIMARY KEY, name TEXT NOT NULL, adapter_id TEXT NOT NULL, style_profile_id TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE job_item (job_id TEXT NOT NULL, asset_id TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (job_id, asset_id));
      INSERT INTO job VALUES ('j', 'old', 'xmp-sidecar', 'p', 't');
      INSERT INTO job_item VALUES ('j', 'a.cr3', 'review', '{"jobId":"j","assetId":"a.cr3","state":"review","attempts":0}');
    `);
    legacy.close();

    const store = new SqliteStore(file);
    expect(store.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(store.listItems("j").map((i) => i.assetId)).toEqual(["a.cr3"]);
    store.appendAudit({ at: "t", action: "after-upgrade" });
    expect(store.listAudit()).toHaveLength(1);
    store.close();
  });

  it("refuses a database written by a newer app", () => {
    const file = path.join(dir, "future.db");
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const future = new DatabaseSync(file);
    future.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    future.close();
    expect(() => new SqliteStore(file)).toThrow(/newer than this app supports/);
  });

  it("is idempotent when reopened", () => {
    const file = path.join(dir, "again.db");
    new SqliteStore(file).close();
    const again = new SqliteStore(file);
    expect(again.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    again.close();
  });
});

describe("SqliteStore sharing a file with another program", () => {
  /** A second program that takes a lock on the file, says so, and lets go after `holdMs`. */
  async function holdLock(file: string, statements: string, holdMs: number) {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
         const db = new DatabaseSync(${JSON.stringify(file)});
         ${statements}
         console.log("holding");
         setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, ${holdMs});`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await once(child.stdout, "data");
    return { released: once(child, "exit") };
  }

  it("waits for a reader instead of failing when it opens a new database (a second command, or the review UI, was reading it)", async () => {
    const file = path.join(dir, "contended-open.db");
    const holder = await holdLock(file, `db.exec("BEGIN"); db.prepare("SELECT count(*) FROM sqlite_master").all();`, 500);
    try {
      const store = new SqliteStore(file);
      expect(store.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
      store.close();
    } finally {
      await holder.released;
    }
  });

  it("waits for another writer instead of failing when it saves", async () => {
    const file = path.join(dir, "contended-write.db");
    const store = new SqliteStore(file);
    const holder = await holdLock(file, `db.exec("BEGIN IMMEDIATE");`, 500);
    try {
      store.appendAudit({ at: "t", action: "while-another-writes" });
      expect(store.listAudit().map((a) => a.action)).toEqual(["while-another-writes"]);
    } finally {
      await holder.released;
      store.close();
    }
  });
});
