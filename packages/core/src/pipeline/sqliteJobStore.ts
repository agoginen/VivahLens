import type { DatabaseSync as Db } from "node:sqlite";
import type { JobItem, JobMeta, JobStore } from "./jobStore.js";

// Loaded at runtime because bundlers (Vite/Vitest) mangle the experimental `node:sqlite` specifier.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

/** Durable job state so a large batch survives app restarts and crashes (plan §2.8). */
export class SqliteJobStore implements JobStore {
  private readonly db: Db;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS job (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, adapter_id TEXT NOT NULL,
        style_profile_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_item (
        job_id TEXT NOT NULL, asset_id TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (job_id, asset_id)
      );
    `);
  }

  ensureJob(meta: JobMeta): void {
    this.db
      .prepare("INSERT OR IGNORE INTO job (id, name, adapter_id, style_profile_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(meta.id, meta.name, meta.adapterId, meta.styleProfileId, meta.createdAt);
  }

  getJob(id: string): JobMeta | undefined {
    const row = this.db.prepare("SELECT * FROM job WHERE id = ?").get(id) as
      | { id: string; name: string; adapter_id: string; style_profile_id: string; created_at: string }
      | undefined;
    return row && {
      id: row.id,
      name: row.name,
      adapterId: row.adapter_id,
      styleProfileId: row.style_profile_id,
      createdAt: row.created_at,
    };
  }

  listItems(jobId: string): JobItem[] {
    const rows = this.db.prepare("SELECT body FROM job_item WHERE job_id = ? ORDER BY rowid").all(jobId) as {
      body: string;
    }[];
    return rows.map((r) => JSON.parse(r.body) as JobItem);
  }

  putItem(item: JobItem): void {
    this.db
      .prepare(
        "INSERT INTO job_item (job_id, asset_id, state, body) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (job_id, asset_id) DO UPDATE SET state = excluded.state, body = excluded.body",
      )
      .run(item.jobId, item.assetId, item.state, JSON.stringify(item));
  }

  close(): void {
    this.db.close();
  }
}
