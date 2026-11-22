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

export class MemoryCloudStore implements CloudStore {
  private accounts = new Map<string, Account>();
  private subscriptions = new Map<string, Subscription>();
  private licenses = new Map<string, License>();
  private activations = new Map<string, Activation>();
  private usage = new Map<string, UsageEvent>();
  private profiles = new Map<string, StyleProfileRecord>();
  private webhooks = new Set<string>();
  private documents = new Map<string, HostedDocument>();

  createAccount(a: Account): void {
    if (this.getAccountByEmail(a.email)) throw new Error("email already registered");
    this.accounts.set(a.id, structuredClone(a));
  }
  getAccount(id: string): Account | undefined {
    return clone(this.accounts.get(id));
  }
  getAccountByEmail(email: string): Account | undefined {
    return clone([...this.accounts.values()].find((a) => a.email === email));
  }

  upsertSubscription(s: Subscription): void {
    const existing = this.subscriptions.get(s.accountId);
    this.subscriptions.set(s.accountId, structuredClone({ ...s, ...((s.billing ?? existing?.billing) && { billing: s.billing ?? existing!.billing }) }));
  }
  getSubscription(accountId: string): Subscription | undefined {
    return clone(this.subscriptions.get(accountId));
  }
  applyBillingSubscription(s: Subscription & { billing: Subscription["billing"] & object }): boolean {
    const existing = this.subscriptions.get(s.accountId);
    if (existing?.billing && existing.billing.eventAt > s.billing.eventAt) return false;
    this.subscriptions.set(s.accountId, structuredClone(s));
    return true;
  }
  findAccountByBilling(provider: "paddle", ref: { customerId?: string; subscriptionId?: string }): string | undefined {
    for (const s of this.subscriptions.values()) {
      const b = s.billing;
      if (!b || b.provider !== provider) continue;
      if ((ref.subscriptionId !== undefined && b.subscriptionId === ref.subscriptionId) || (ref.customerId !== undefined && b.customerId === ref.customerId)) return s.accountId;
    }
    return undefined;
  }

  createLicense(l: License): void {
    if (this.getLicenseByKeyHash(l.keyHash)) throw new Error("license key collision");
    this.licenses.set(l.id, structuredClone(l));
  }
  getLicense(id: string): License | undefined {
    return clone(this.licenses.get(id));
  }
  getLicenseByKeyHash(keyHash: string): License | undefined {
    return clone([...this.licenses.values()].find((l) => l.keyHash === keyHash));
  }
  listLicenses(accountId: string): License[] {
    return [...this.licenses.values()].filter((l) => l.accountId === accountId).map((l) => structuredClone(l));
  }
  revokeLicense(id: string, at: number): void {
    const l = this.licenses.get(id);
    if (l && l.revokedAt === null) l.revokedAt = at;
  }

  upsertActivation(a: Activation): Activation {
    const existing = [...this.activations.values()].find((x) => x.licenseId === a.licenseId && x.deviceId === a.deviceId);
    const stored: Activation = existing
      ? { ...existing, deviceName: a.deviceName, refreshTokenHash: a.refreshTokenHash, lastSeenAt: a.lastSeenAt, revokedAt: null }
      : structuredClone(a);
    this.activations.set(stored.id, stored);
    return structuredClone(stored);
  }
  getActivation(id: string): Activation | undefined {
    return clone(this.activations.get(id));
  }
  getActivationByRefreshHash(hash: string): Activation | undefined {
    return clone([...this.activations.values()].find((a) => a.refreshTokenHash === hash));
  }
  listActivations(licenseId: string): Activation[] {
    return [...this.activations.values()].filter((a) => a.licenseId === licenseId).map((a) => structuredClone(a));
  }
  touchActivation(id: string, at: number): void {
    const a = this.activations.get(id);
    if (a) a.lastSeenAt = at;
  }
  revokeActivation(id: string, at: number): void {
    const a = this.activations.get(id);
    if (a && a.revokedAt === null) a.revokedAt = at;
  }

  recordUsage(events: readonly UsageEvent[]): { accepted: number; duplicates: number } {
    let accepted = 0;
    let duplicates = 0;
    for (const e of events) {
      const key = `${e.activationId}\0${e.eventId}`;
      if (this.usage.has(key)) duplicates++;
      else {
        this.usage.set(key, structuredClone(e));
        accepted++;
      }
    }
    return { accepted, duplicates };
  }

  putStyleProfile(
    p: { accountId: string; profileId: string; name: string; blob: string; now: number },
    expectedVersion: number | null,
  ): StyleProfileRecord | undefined {
    const key = `${p.accountId}\0${p.profileId}`;
    const current = this.profiles.get(key);
    if (expectedVersion === null ? current : current?.version !== expectedVersion) return undefined;
    const next: StyleProfileRecord = { accountId: p.accountId, profileId: p.profileId, name: p.name, blob: p.blob, version: (current?.version ?? 0) + 1, updatedAt: p.now };
    this.profiles.set(key, next);
    return structuredClone(next);
  }
  getStyleProfile(accountId: string, profileId: string): StyleProfileRecord | undefined {
    return clone(this.profiles.get(`${accountId}\0${profileId}`));
  }
  listStyleProfiles(accountId: string): Omit<StyleProfileRecord, "blob">[] {
    return [...this.profiles.values()]
      .filter((p) => p.accountId === accountId)
      .map(({ blob: _blob, ...rest }) => rest)
      .sort((a, b) => a.profileId.localeCompare(b.profileId));
  }

  recordWebhookEvent(id: string): boolean {
    if (this.webhooks.has(id)) return false;
    this.webhooks.add(id);
    return true;
  }
  unrecordWebhookEvent(id: string): void {
    this.webhooks.delete(id);
  }

  putDocument(document: HostedDocument): void {
    this.documents.set(document.name, { ...document, bytes: Buffer.from(document.bytes) });
  }
  getDocument(name: string): HostedDocument | undefined {
    const found = this.documents.get(name);
    return found && { ...found, bytes: Buffer.from(found.bytes) };
  }
}

const clone = <T>(v: T | undefined): T | undefined => (v === undefined ? undefined : structuredClone(v));
