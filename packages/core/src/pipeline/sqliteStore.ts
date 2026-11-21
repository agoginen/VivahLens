import type { DatabaseSync as Db } from "node:sqlite";
import type { StyleProfile } from "../style/styleProfile.js";
import type { AssetRecord, AuditEvent, OverrideRecord, Store } from "./libraryStore.js";
import type { JobItem, JobMeta } from "./jobStore.js";

// Loaded at runtime because bundlers (Vite/Vitest) mangle the experimental `node:sqlite` specifier.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

/** Forward-only schema migrations, applied in order and recorded in `PRAGMA user_version`. */
const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS job (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, adapter_id TEXT NOT NULL,
        style_profile_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_item (
        job_id TEXT NOT NULL, asset_id TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (job_id, asset_id)
      );`,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE asset (
        fingerprint TEXT NOT NULL, path TEXT NOT NULL, exif TEXT,
        first_seen_job TEXT NOT NULL, first_seen_at TEXT NOT NULL,
        PRIMARY KEY (fingerprint, path)
      );
      CREATE TABLE audit_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL,
        job_id TEXT, asset_id TEXT, meta TEXT
      );
      CREATE TABLE override (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, asset_id TEXT NOT NULL,
        path TEXT NOT NULL, old_value REAL, new_value REAL NOT NULL, at TEXT NOT NULL
      );
      CREATE INDEX override_job ON override (job_id);
      CREATE TABLE style_profile (
        id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

/** Durable store so a large batch survives restarts and crashes (plan §2.8), plus the cross-job library (§7b). */
export class SqliteStore implements Store {
  private readonly db: Db;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.migrate();
    } catch (err) {
      // Do not leak the connection (and a file lock on Windows) when the database cannot be used.
      this.db.close();
      throw err;
    }
  }

  private migrate(): void {
    const current = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (current > LATEST_SCHEMA_VERSION) {
      throw new Error(`Database schema v${current} is newer than this app supports (v${LATEST_SCHEMA_VERSION}); update the app`);
    }
    for (const m of MIGRATIONS.filter((x) => x.version > current)) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(m.sql);
        this.db.exec(`PRAGMA user_version = ${m.version}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  schemaVersion(): number {
    return (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
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
    return (
      row && {
        id: row.id,
        name: row.name,
        adapterId: row.adapter_id,
        styleProfileId: row.style_profile_id,
        createdAt: row.created_at,
      }
    );
  }

  listItems(jobId: string): JobItem[] {
    const rows = this.db.prepare("SELECT body FROM job_item WHERE job_id = ? ORDER BY rowid").all(jobId) as { body: string }[];
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

  putAsset(a: AssetRecord): void {
    this.db
      .prepare("INSERT OR IGNORE INTO asset (fingerprint, path, exif, first_seen_job, first_seen_at) VALUES (?, ?, ?, ?, ?)")
      .run(a.fingerprint, a.path, a.exif ? JSON.stringify(a.exif) : null, a.firstSeenJob, a.firstSeenAt);
  }

  findAssetsByFingerprint(fingerprint: string): AssetRecord[] {
    const rows = this.db.prepare("SELECT * FROM asset WHERE fingerprint = ? ORDER BY first_seen_at").all(fingerprint) as {
      fingerprint: string;
      path: string;
      exif: string | null;
      first_seen_job: string;
      first_seen_at: string;
    }[];
    return rows.map((r) => ({
      fingerprint: r.fingerprint,
      path: r.path,
      exif: r.exif ? (JSON.parse(r.exif) as Record<string, unknown>) : undefined,
      firstSeenJob: r.first_seen_job,
      firstSeenAt: r.first_seen_at,
    }));
  }

  appendAudit(e: AuditEvent): void {
    this.db
      .prepare("INSERT INTO audit_event (at, action, job_id, asset_id, meta) VALUES (?, ?, ?, ?, ?)")
      .run(e.at, e.action, e.jobId ?? null, e.assetId ?? null, e.meta ? JSON.stringify(e.meta) : null);
  }

  listAudit(filter?: { jobId?: string }): AuditEvent[] {
    const rows = (
      filter?.jobId
        ? this.db.prepare("SELECT * FROM audit_event WHERE job_id = ? ORDER BY id").all(filter.jobId)
        : this.db.prepare("SELECT * FROM audit_event ORDER BY id").all()
    ) as { at: string; action: string; job_id: string | null; asset_id: string | null; meta: string | null }[];
    return rows.map((r) => ({
      at: r.at,
      action: r.action,
      ...(r.job_id && { jobId: r.job_id }),
      ...(r.asset_id && { assetId: r.asset_id }),
      ...(r.meta && { meta: JSON.parse(r.meta) as Record<string, unknown> }),
    }));
  }

  recordOverrides(overrides: readonly OverrideRecord[]): void {
    const insert = this.db.prepare("INSERT INTO override (job_id, asset_id, path, old_value, new_value, at) VALUES (?, ?, ?, ?, ?, ?)");
    for (const o of overrides) insert.run(o.jobId, o.assetId, o.path, o.oldValue ?? null, o.newValue, o.at);
  }

  listOverrides(jobId: string): OverrideRecord[] {
    const rows = this.db.prepare("SELECT * FROM override WHERE job_id = ? ORDER BY id").all(jobId) as {
      job_id: string;
      asset_id: string;
      path: string;
      old_value: number | null;
      new_value: number;
      at: string;
    }[];
    return rows.map((r) => ({
      jobId: r.job_id,
      assetId: r.asset_id,
      path: r.path as OverrideRecord["path"],
      ...(r.old_value !== null && { oldValue: r.old_value }),
      newValue: r.new_value,
      at: r.at,
    }));
  }

  saveProfile(profile: StyleProfile): void {
    this.db
      .prepare("INSERT OR IGNORE INTO style_profile (id, version, body, created_at) VALUES (?, ?, ?, ?)")
      .run(profile.id, profile.version, JSON.stringify(profile), new Date().toISOString());
  }

  loadProfile(id: string, version?: number): StyleProfile | undefined {
    const row = (
      version === undefined
        ? this.db.prepare("SELECT body FROM style_profile WHERE id = ? ORDER BY version DESC LIMIT 1").get(id)
        : this.db.prepare("SELECT body FROM style_profile WHERE id = ? AND version = ?").get(id, version)
    ) as { body: string } | undefined;
    return row && (JSON.parse(row.body) as StyleProfile);
  }

  close(): void {
    this.db.close();
  }
}
