import type { DatabaseSync as Db } from "node:sqlite";
import type { OutboundEvent } from "../privacy/outbound.js";
import { CURRENT_RECIPE_VERSION, migrateRecipe } from "../recipe/migrate.js";
import type { StyleProfile } from "../style/styleProfile.js";
import {
  pickRecipe,
  type AssetRecord,
  type AuditEvent,
  type DeliveryRecord,
  type OverrideRecord,
  type RecipeRecord,
  type Store,
  type UndoEntry,
} from "./libraryStore.js";
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
  {
    version: 3,
    sql: `
      CREATE TABLE recipe (
        id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, fingerprint TEXT NOT NULL,
        profile_id TEXT NOT NULL, profile_version INTEGER NOT NULL, schema_version TEXT NOT NULL,
        json TEXT NOT NULL, source TEXT NOT NULL, confidence REAL,
        job_id TEXT NOT NULL, asset_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX recipe_lookup ON recipe (fingerprint, profile_id);
      CREATE TABLE undo_entry (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, asset_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL, target TEXT NOT NULL, backup TEXT, written_sha256 TEXT, at TEXT NOT NULL, undone_at TEXT
      );
      CREATE INDEX undo_job ON undo_entry (job_id);
      CREATE TABLE outbound_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, job_id TEXT, provider TEXT NOT NULL, model TEXT,
        purpose TEXT NOT NULL, images INTEGER NOT NULL, image_bytes INTEGER NOT NULL, max_edge_px INTEGER,
        full_resolution INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER, output_tokens INTEGER, failed INTEGER NOT NULL DEFAULT 0,
        local INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX outbound_job ON outbound_event (job_id);
      CREATE TABLE delivery (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, asset_id TEXT NOT NULL,
        destination TEXT NOT NULL, at TEXT NOT NULL, bytes INTEGER
      );
      CREATE INDEX delivery_job ON delivery (job_id);`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

/** Durable store so a large batch survives restarts and crashes (plan §2.8), plus the cross-job library (§7b). */
export class SqliteStore implements Store {
  private readonly db: Db;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      // Another program (a second command, the review UI) may be using the file right now: wait for its lock instead of failing at once.
      this.db.exec("PRAGMA busy_timeout = 5000;");
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
    return rows.map((r) => {
      const item = JSON.parse(r.body) as JobItem;
      // Recipes saved by an older version are brought forward on the way out (plan §7b, converter chain).
      if (item.recipe && item.recipe.version !== CURRENT_RECIPE_VERSION) {
        try {
          item.recipe = migrateRecipe(item.recipe);
        } catch (err) {
          // One recipe from a newer app must not make the whole job unreadable; that photo is shown as failed instead.
          const { recipe: _unreadable, ...rest } = item;
          return { ...rest, state: "failed", failedFrom: item.state === "failed" ? item.failedFrom : item.state, errorCode: "RECIPE_UNREADABLE", errorMessage: err instanceof Error ? err.message : String(err) };
        }
      }
      return item;
    });
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

  putRecipe(r: RecipeRecord): void {
    this.db
      .prepare(
        "INSERT INTO recipe (hash, fingerprint, profile_id, profile_version, schema_version, json, source, confidence, job_id, asset_id, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(r.hash, r.fingerprint, r.profileId, r.profileVersion, r.recipe.version, JSON.stringify(r.recipe), r.source, r.confidence ?? null, r.jobId, r.assetId, r.createdAt);
  }

  findRecipe(fingerprint: string, profileId: string, profileVersion: number): RecipeRecord | undefined {
    const rows = this.db.prepare("SELECT * FROM recipe WHERE fingerprint = ? AND profile_id = ? ORDER BY id").all(fingerprint, profileId) as {
      hash: string;
      fingerprint: string;
      profile_id: string;
      profile_version: number;
      json: string;
      source: "llm" | "override";
      confidence: number | null;
      job_id: string;
      asset_id: string;
      created_at: string;
    }[];
    const records: RecipeRecord[] = [];
    for (const r of rows) {
      try {
        records.push({
          hash: r.hash,
          fingerprint: r.fingerprint,
          profileId: r.profile_id,
          profileVersion: r.profile_version,
          recipe: migrateRecipe(JSON.parse(r.json)),
          source: r.source,
          ...(r.confidence !== null && { confidence: r.confidence }),
          jobId: r.job_id,
          assetId: r.asset_id,
          createdAt: r.created_at,
        });
      } catch {
        // A recipe that can no longer be read is simply not offered as a cached answer.
      }
    }
    return pickRecipe(records, fingerprint, profileId, profileVersion);
  }

  recordUndo(e: Omit<UndoEntry, "id">): void {
    this.db
      .prepare("INSERT INTO undo_entry (job_id, asset_id, adapter_id, target, backup, written_sha256, at, undone_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(e.jobId, e.assetId, e.adapterId, e.target, e.backup ?? null, e.writtenSha256 ?? null, e.at, e.undoneAt ?? null);
  }

  listUndo(jobId: string, opts?: { pending?: boolean }): UndoEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM undo_entry WHERE job_id = ? ${opts?.pending ? "AND undone_at IS NULL" : ""} ORDER BY id DESC`)
      .all(jobId) as { id: number; job_id: string; asset_id: string; adapter_id: string; target: string; backup: string | null; written_sha256: string | null; at: string; undone_at: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      assetId: r.asset_id,
      adapterId: r.adapter_id,
      target: r.target,
      ...(r.backup && { backup: r.backup }),
      ...(r.written_sha256 && { writtenSha256: r.written_sha256 }),
      at: r.at,
      ...(r.undone_at && { undoneAt: r.undone_at }),
    }));
  }

  markUndone(id: number, at: string): void {
    this.db.prepare("UPDATE undo_entry SET undone_at = ? WHERE id = ?").run(at, id);
  }

  recordOutbound(e: OutboundEvent): void {
    this.db
      .prepare(
        "INSERT INTO outbound_event (at, job_id, provider, model, purpose, images, image_bytes, max_edge_px, full_resolution, input_tokens, output_tokens, failed, local) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(e.at, e.jobId ?? null, e.provider, e.model ?? null, e.purpose, e.images, e.imageBytes, e.maxEdgePx ?? null, e.fullResolution ? 1 : 0, e.inputTokens ?? null, e.outputTokens ?? null, e.failed ? 1 : 0, e.local ? 1 : 0);
  }

  listOutbound(filter?: { jobId?: string }): OutboundEvent[] {
    const rows = (
      filter?.jobId
        ? this.db.prepare("SELECT * FROM outbound_event WHERE job_id = ? ORDER BY id").all(filter.jobId)
        : this.db.prepare("SELECT * FROM outbound_event ORDER BY id").all()
    ) as {
      at: string;
      job_id: string | null;
      provider: string;
      model: string | null;
      purpose: OutboundEvent["purpose"];
      images: number;
      image_bytes: number;
      max_edge_px: number | null;
      full_resolution: number;
      input_tokens: number | null;
      output_tokens: number | null;
      failed: number;
      local: number;
    }[];
    return rows.map((r) => ({
      at: r.at,
      ...(r.job_id && { jobId: r.job_id }),
      provider: r.provider,
      ...(r.model && { model: r.model }),
      purpose: r.purpose,
      images: r.images,
      imageBytes: r.image_bytes,
      ...(r.max_edge_px !== null && { maxEdgePx: r.max_edge_px }),
      ...(r.full_resolution === 1 && { fullResolution: true }),
      ...(r.input_tokens !== null && { inputTokens: r.input_tokens }),
      ...(r.output_tokens !== null && { outputTokens: r.output_tokens }),
      ...(r.failed === 1 && { failed: true }),
      ...(r.local === 1 && { local: true }),
    }));
  }

  recordDelivery(d: DeliveryRecord): void {
    this.db.prepare("INSERT INTO delivery (job_id, asset_id, destination, at, bytes) VALUES (?, ?, ?, ?, ?)").run(d.jobId, d.assetId, d.destination, d.at, d.bytes ?? null);
  }

  listDeliveries(jobId: string): DeliveryRecord[] {
    const rows = this.db.prepare("SELECT * FROM delivery WHERE job_id = ? ORDER BY id").all(jobId) as { job_id: string; asset_id: string; destination: string; at: string; bytes: number | null }[];
    return rows.map((r) => ({ jobId: r.job_id, assetId: r.asset_id, destination: r.destination, at: r.at, ...(r.bytes !== null && { bytes: r.bytes }) }));
  }

  close(): void {
    this.db.close();
  }
}
