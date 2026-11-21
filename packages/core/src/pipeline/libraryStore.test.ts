import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { StyleProfile } from "../style/styleProfile.js";
import { MemoryStore, type Store } from "./libraryStore.js";
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
