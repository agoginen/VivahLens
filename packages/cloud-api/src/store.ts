export type Plan = "trial" | "starter" | "pro" | "studio";
export type SubscriptionStatus = "active" | "trialing" | "past_due" | "paused" | "canceled";

export interface Account {
  id: string;
  email: string;
  createdAt: number;
}

/** Where a subscription came from at the billing provider, and when the newest event applied to it happened there. */
export interface BillingLink {
  provider: "paddle";
  customerId: string;
  subscriptionId: string;
  /** Unix ms of the provider event this state is derived from; an event that happened earlier never overwrites it. */
  eventAt: number;
}

export interface Subscription {
  accountId: string;
  plan: Plan;
  seats: number;
  adapters: string[];
  status: SubscriptionStatus;
  /** Unix ms the paid period ends, if the billing provider told us. */
  currentPeriodEnd: number | null;
  updatedAt: number;
  billing?: BillingLink;
}

export interface License {
  id: string;
  accountId: string;
  /** SHA-256 hex of the normalised key; the plaintext key is never stored. */
  keyHash: string;
  maxDevices: number;
  createdAt: number;
  revokedAt: number | null;
}

export interface Activation {
  id: string;
  licenseId: string;
  deviceId: string;
  deviceName: string;
  /** SHA-256 hex of the refresh token; the token itself is never stored. */
  refreshTokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

/** Counts and cost only: usage events never carry image, prompt or file content. */
export interface UsageEvent {
  activationId: string;
  eventId: string;
  at: number;
  photos: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface StyleProfileRecord {
  accountId: string;
  profileId: string;
  version: number;
  name: string;
  /** Opaque base64 payload (the client encrypts it); the server never interprets it. */
  blob: string;
  updatedAt: number;
}

/**
 * A signed document held for clients to fetch: a release manifest, the remote config. The server stores and serves the
 * bytes and the detached signature as they were published. It holds no signing key and does not trust the contents.
 */
export interface HostedDocument {
  name: string;
  bytes: Buffer;
  /** The signature file's JSON text, served as it was given. */
  signature: string;
  updatedAt: number;
}

export interface CloudStore {
  createAccount(account: Account): void;
  getAccount(id: string): Account | undefined;
  getAccountByEmail(email: string): Account | undefined;

  /** Writes a subscription set by hand (admin API). A billing link already on record is kept when the new one has none. */
  upsertSubscription(subscription: Subscription): void;
  getSubscription(accountId: string): Subscription | undefined;
  /**
   * Writes a subscription derived from a billing-provider event, unless the stored one came from a later event
   * (providers deliver out of order). Returns whether it was written.
   */
  applyBillingSubscription(subscription: Subscription & { billing: BillingLink }): boolean;
  /** The account a provider's customer or subscription id was linked to by an earlier event. */
  findAccountByBilling(provider: BillingLink["provider"], ref: { customerId?: string; subscriptionId?: string }): string | undefined;

  createLicense(license: License): void;
  getLicense(id: string): License | undefined;
  getLicenseByKeyHash(keyHash: string): License | undefined;
  listLicenses(accountId: string): License[];
  revokeLicense(id: string, at: number): void;

  /** Creates the activation, or for an existing (license, device) pair replaces its token and clears any revocation, keeping its id. */
  upsertActivation(activation: Activation): Activation;
  getActivation(id: string): Activation | undefined;
  getActivationByRefreshHash(hash: string): Activation | undefined;
  listActivations(licenseId: string): Activation[];
  touchActivation(id: string, at: number): void;
  revokeActivation(id: string, at: number): void;

  recordUsage(events: readonly UsageEvent[]): { accepted: number; duplicates: number };

  /** `expectedVersion` null means "must not exist yet". Returns undefined on a version conflict (nothing written). */
  putStyleProfile(
    profile: { accountId: string; profileId: string; name: string; blob: string; now: number },
    expectedVersion: number | null,
  ): StyleProfileRecord | undefined;
  getStyleProfile(accountId: string, profileId: string): StyleProfileRecord | undefined;
  listStyleProfiles(accountId: string): Omit<StyleProfileRecord, "blob">[];

  /** True the first time an event id is seen. */
  recordWebhookEvent(id: string, at: number): boolean;
  /** Lets a provider's retry through again after processing the event failed. */
  unrecordWebhookEvent(id: string): void;

  /** Publishes a document, replacing any earlier one of the same name. */
  putDocument(document: HostedDocument): void;
  getDocument(name: string): HostedDocument | undefined;

  close?(): void;
}
