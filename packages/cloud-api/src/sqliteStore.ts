import type { DatabaseSync as Db } from "node:sqlite";
import type {
  Account,
  Activation,
  CloudStore,
  HostedDocument,
  License,
  StyleProfileRecord,
  Subscription,
  UsageEvent,
} from "./store.js";

// Loaded at runtime because bundlers (Vite/Vitest) mangle the experimental `node:sqlite` specifier.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

/** Forward-only migrations recorded in `PRAGMA user_version`. */
const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE subscription (
        account_id TEXT PRIMARY KEY, plan TEXT NOT NULL, seats INTEGER NOT NULL, adapters TEXT NOT NULL,
        status TEXT NOT NULL, current_period_end INTEGER, updated_at INTEGER NOT NULL
      );
      CREATE TABLE license (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
        max_devices INTEGER NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE INDEX license_account ON license (account_id);
      CREATE TABLE activation (
        id TEXT PRIMARY KEY, license_id TEXT NOT NULL, device_id TEXT NOT NULL, device_name TEXT NOT NULL,
        refresh_token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER, UNIQUE (license_id, device_id)
      );
      CREATE TABLE usage_event (
        activation_id TEXT NOT NULL, event_id TEXT NOT NULL, at INTEGER NOT NULL, photos INTEGER NOT NULL,
        llm_calls INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL, PRIMARY KEY (activation_id, event_id)
      );
      CREATE TABLE style_profile (
        account_id TEXT NOT NULL, profile_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL,
        blob TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (account_id, profile_id)
      );
      CREATE TABLE webhook_event (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);`,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE subscription ADD COLUMN billing_provider TEXT;
      ALTER TABLE subscription ADD COLUMN billing_customer_id TEXT;
      ALTER TABLE subscription ADD COLUMN billing_subscription_id TEXT;
      ALTER TABLE subscription ADD COLUMN billing_event_at INTEGER;
      CREATE INDEX subscription_billing_customer ON subscription (billing_provider, billing_customer_id);
      CREATE INDEX subscription_billing_subscription ON subscription (billing_provider, billing_subscription_id);`,
  },
  {
    version: 3,
    sql: `CREATE TABLE document (name TEXT PRIMARY KEY, bytes BLOB NOT NULL, signature TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
  },
];

export const CLOUD_SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

type Row = Record<string, unknown>;

export class SqliteCloudStore implements CloudStore {
  private readonly db: Db;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      this.migrate();
    } catch (err) {
      // Do not leak the connection (and a file lock on Windows) when the database cannot be used.
      this.db.close();
      throw err;
    }
  }

  private migrate(): void {
    const current = this.schemaVersion();
    if (current > CLOUD_SCHEMA_VERSION) {
      throw new Error(`Database schema v${current} is newer than this server supports (v${CLOUD_SCHEMA_VERSION})`);
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

  createAccount(a: Account): void {
    this.db.prepare("INSERT INTO account (id, email, created_at) VALUES (?, ?, ?)").run(a.id, a.email, a.createdAt);
  }
  getAccount(id: string): Account | undefined {
    return account(this.db.prepare("SELECT * FROM account WHERE id = ?").get(id) as Row | undefined);
  }
  getAccountByEmail(email: string): Account | undefined {
    return account(this.db.prepare("SELECT * FROM account WHERE email = ?").get(email) as Row | undefined);
  }

  upsertSubscription(s: Subscription): void {
    // A billing link already on record is kept when the new subscription carries none (an operator's manual correction).
    this.db
      .prepare(
        `INSERT INTO subscription (account_id, plan, seats, adapters, status, current_period_end, updated_at,
           billing_provider, billing_customer_id, billing_subscription_id, billing_event_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET plan = excluded.plan, seats = excluded.seats, adapters = excluded.adapters,
           status = excluded.status, current_period_end = excluded.current_period_end, updated_at = excluded.updated_at,
           billing_provider = COALESCE(excluded.billing_provider, billing_provider),
           billing_customer_id = COALESCE(excluded.billing_customer_id, billing_customer_id),
           billing_subscription_id = COALESCE(excluded.billing_subscription_id, billing_subscription_id),
           billing_event_at = COALESCE(excluded.billing_event_at, billing_event_at)`,
      )
      .run(s.accountId, s.plan, s.seats, JSON.stringify(s.adapters), s.status, s.currentPeriodEnd, s.updatedAt, s.billing?.provider ?? null, s.billing?.customerId ?? null, s.billing?.subscriptionId ?? null, s.billing?.eventAt ?? null);
  }
  getSubscription(accountId: string): Subscription | undefined {
    const r = this.db.prepare("SELECT * FROM subscription WHERE account_id = ?").get(accountId) as Row | undefined;
    return (
      r && {
        accountId: r.account_id as string,
        plan: r.plan as Subscription["plan"],
        seats: r.seats as number,
        adapters: JSON.parse(r.adapters as string) as string[],
        status: r.status as Subscription["status"],
        currentPeriodEnd: (r.current_period_end as number | null) ?? null,
        updatedAt: r.updated_at as number,
        ...(r.billing_provider !== null && r.billing_provider !== undefined && {
          billing: {
            provider: r.billing_provider as "paddle",
            customerId: r.billing_customer_id as string,
            subscriptionId: r.billing_subscription_id as string,
            eventAt: r.billing_event_at as number,
          },
        }),
      }
    );
  }
  applyBillingSubscription(s: Subscription & { billing: NonNullable<Subscription["billing"]> }): boolean {
    // One statement, so the "newer than what is stored" check and the write cannot be separated.
    const changed = this.db
      .prepare(
        `INSERT INTO subscription (account_id, plan, seats, adapters, status, current_period_end, updated_at,
           billing_provider, billing_customer_id, billing_subscription_id, billing_event_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET plan = excluded.plan, seats = excluded.seats, adapters = excluded.adapters,
           status = excluded.status, current_period_end = excluded.current_period_end, updated_at = excluded.updated_at,
           billing_provider = excluded.billing_provider, billing_customer_id = excluded.billing_customer_id,
           billing_subscription_id = excluded.billing_subscription_id, billing_event_at = excluded.billing_event_at
         WHERE subscription.billing_event_at IS NULL OR subscription.billing_event_at <= excluded.billing_event_at`,
      )
      .run(s.accountId, s.plan, s.seats, JSON.stringify(s.adapters), s.status, s.currentPeriodEnd, s.updatedAt, s.billing.provider, s.billing.customerId, s.billing.subscriptionId, s.billing.eventAt).changes;
    return Number(changed) === 1;
  }
  findAccountByBilling(provider: "paddle", ref: { customerId?: string; subscriptionId?: string }): string | undefined {
    if (ref.subscriptionId !== undefined) {
      const bySub = this.db.prepare("SELECT account_id FROM subscription WHERE billing_provider = ? AND billing_subscription_id = ?").get(provider, ref.subscriptionId) as Row | undefined;
      if (bySub) return bySub.account_id as string;
    }
    if (ref.customerId !== undefined) {
      const byCustomer = this.db.prepare("SELECT account_id FROM subscription WHERE billing_provider = ? AND billing_customer_id = ?").get(provider, ref.customerId) as Row | undefined;
      if (byCustomer) return byCustomer.account_id as string;
    }
    return undefined;
  }

  createLicense(l: License): void {
    this.db
      .prepare("INSERT INTO license (id, account_id, key_hash, max_devices, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(l.id, l.accountId, l.keyHash, l.maxDevices, l.createdAt, l.revokedAt);
  }
  getLicense(id: string): License | undefined {
    return license(this.db.prepare("SELECT * FROM license WHERE id = ?").get(id) as Row | undefined);
  }
  getLicenseByKeyHash(keyHash: string): License | undefined {
    return license(this.db.prepare("SELECT * FROM license WHERE key_hash = ?").get(keyHash) as Row | undefined);
  }
  listLicenses(accountId: string): License[] {
    return (this.db.prepare("SELECT * FROM license WHERE account_id = ? ORDER BY created_at, id").all(accountId) as Row[]).map((r) => license(r)!);
  }
  revokeLicense(id: string, at: number): void {
    this.db.prepare("UPDATE license SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id);
  }

  upsertActivation(a: Activation): Activation {
    this.db
      .prepare(
        `INSERT INTO activation (id, license_id, device_id, device_name, refresh_token_hash, created_at, last_seen_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (license_id, device_id) DO UPDATE SET device_name = excluded.device_name,
           refresh_token_hash = excluded.refresh_token_hash, last_seen_at = excluded.last_seen_at, revoked_at = NULL`,
      )
      .run(a.id, a.licenseId, a.deviceId, a.deviceName, a.refreshTokenHash, a.createdAt, a.lastSeenAt);
    return activation(this.db.prepare("SELECT * FROM activation WHERE license_id = ? AND device_id = ?").get(a.licenseId, a.deviceId) as Row)!;
  }
  getActivation(id: string): Activation | undefined {
    return activation(this.db.prepare("SELECT * FROM activation WHERE id = ?").get(id) as Row | undefined);
  }
  getActivationByRefreshHash(hash: string): Activation | undefined {
    return activation(this.db.prepare("SELECT * FROM activation WHERE refresh_token_hash = ?").get(hash) as Row | undefined);
  }
  listActivations(licenseId: string): Activation[] {
    return (this.db.prepare("SELECT * FROM activation WHERE license_id = ? ORDER BY created_at, id").all(licenseId) as Row[]).map((r) => activation(r)!);
  }
  touchActivation(id: string, at: number): void {
    this.db.prepare("UPDATE activation SET last_seen_at = ? WHERE id = ?").run(at, id);
  }
  revokeActivation(id: string, at: number): void {
    this.db.prepare("UPDATE activation SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id);
  }

  recordUsage(events: readonly UsageEvent[]): { accepted: number; duplicates: number } {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO usage_event (activation_id, event_id, at, photos, llm_calls, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    let accepted = 0;
    this.db.exec("BEGIN");
    try {
      for (const e of events) {
        accepted += Number(insert.run(e.activationId, e.eventId, e.at, e.photos, e.llmCalls, e.inputTokens, e.outputTokens, e.costUsd).changes);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { accepted, duplicates: events.length - accepted };
  }

  putStyleProfile(
    p: { accountId: string; profileId: string; name: string; blob: string; now: number },
    expectedVersion: number | null,
  ): StyleProfileRecord | undefined {
    const changed =
      expectedVersion === null
        ? this.db
            .prepare("INSERT INTO style_profile (account_id, profile_id, version, name, blob, updated_at) VALUES (?, ?, 1, ?, ?, ?) ON CONFLICT DO NOTHING")
            .run(p.accountId, p.profileId, p.name, p.blob, p.now).changes
        : this.db
            .prepare("UPDATE style_profile SET version = version + 1, name = ?, blob = ?, updated_at = ? WHERE account_id = ? AND profile_id = ? AND version = ?")
            .run(p.name, p.blob, p.now, p.accountId, p.profileId, expectedVersion).changes;
    return Number(changed) === 1 ? this.getStyleProfile(p.accountId, p.profileId) : undefined;
  }
  getStyleProfile(accountId: string, profileId: string): StyleProfileRecord | undefined {
    const r = this.db.prepare("SELECT * FROM style_profile WHERE account_id = ? AND profile_id = ?").get(accountId, profileId) as Row | undefined;
    return (
      r && {
        accountId: r.account_id as string,
        profileId: r.profile_id as string,
        version: r.version as number,
        name: r.name as string,
        blob: r.blob as string,
        updatedAt: r.updated_at as number,
      }
    );
  }
  listStyleProfiles(accountId: string): Omit<StyleProfileRecord, "blob">[] {
    const rows = this.db.prepare("SELECT account_id, profile_id, version, name, updated_at FROM style_profile WHERE account_id = ? ORDER BY profile_id").all(accountId) as Row[];
    return rows.map((r) => ({
      accountId: r.account_id as string,
      profileId: r.profile_id as string,
      version: r.version as number,
      name: r.name as string,
      updatedAt: r.updated_at as number,
    }));
  }

  recordWebhookEvent(id: string, at: number): boolean {
    return Number(this.db.prepare("INSERT OR IGNORE INTO webhook_event (id, received_at) VALUES (?, ?)").run(id, at).changes) === 1;
  }
  unrecordWebhookEvent(id: string): void {
    this.db.prepare("DELETE FROM webhook_event WHERE id = ?").run(id);
  }

  putDocument(d: HostedDocument): void {
    this.db.prepare("INSERT INTO document (name, bytes, signature, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET bytes = excluded.bytes, signature = excluded.signature, updated_at = excluded.updated_at").run(d.name, d.bytes, d.signature, d.updatedAt);
  }
  getDocument(name: string): HostedDocument | undefined {
    const r = this.db.prepare("SELECT * FROM document WHERE name = ?").get(name) as Row | undefined;
    return r && { name: r.name as string, bytes: Buffer.from(r.bytes as Uint8Array), signature: r.signature as string, updatedAt: r.updated_at as number };
  }

  close(): void {
    this.db.close();
  }
}

const account = (r: Row | undefined): Account | undefined => r && { id: r.id as string, email: r.email as string, createdAt: r.created_at as number };
const license = (r: Row | undefined): License | undefined =>
  r && {
    id: r.id as string,
    accountId: r.account_id as string,
    keyHash: r.key_hash as string,
    maxDevices: r.max_devices as number,
    createdAt: r.created_at as number,
    revokedAt: (r.revoked_at as number | null) ?? null,
  };
const activation = (r: Row | undefined): Activation | undefined =>
  r && {
    id: r.id as string,
    licenseId: r.license_id as string,
    deviceId: r.device_id as string,
    deviceName: r.device_name as string,
    refreshTokenHash: r.refresh_token_hash as string,
    createdAt: r.created_at as number,
    lastSeenAt: r.last_seen_at as number,
    revokedAt: (r.revoked_at as number | null) ?? null,
  };
