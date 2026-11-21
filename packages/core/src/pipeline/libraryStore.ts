import type { StyleProfile, ScalarPath } from "../style/styleProfile.js";
import type { JobItem, JobMeta, JobStore } from "./jobStore.js";

export interface AssetRecord {
  /** Absolute path at first sight. */
  path: string;
  fingerprint: string;
  /** Camera/lens/exposure metadata as read from the file. */
  exif?: Record<string, unknown>;
  firstSeenJob: string;
  firstSeenAt: string;
}

/** Metadata-only audit trail: never contains image content. */
export interface AuditEvent {
  at: string;
  action: string;
  jobId?: string;
  assetId?: string;
  meta?: Record<string, unknown>;
}

export interface OverrideRecord {
  jobId: string;
  assetId: string;
  path: ScalarPath;
  oldValue?: number;
  newValue: number;
  at: string;
}

/** Cross-job persistence: what we know about files, reviewer corrections, style versions and what happened when. */
export interface LibraryStore {
  putAsset(asset: AssetRecord): void;
  findAssetsByFingerprint(fingerprint: string): AssetRecord[];
  appendAudit(event: AuditEvent): void;
  listAudit(filter?: { jobId?: string }): AuditEvent[];
  recordOverrides(overrides: readonly OverrideRecord[]): void;
  listOverrides(jobId: string): OverrideRecord[];
  /** Stores one immutable version of a profile; the latest is returned by `loadProfile(id)`. */
  saveProfile(profile: StyleProfile): void;
  loadProfile(id: string, version?: number): StyleProfile | undefined;
}

export type Store = JobStore & LibraryStore;

export class MemoryStore implements Store {
  private jobs = new Map<string, JobMeta>();
  private items = new Map<string, JobItem>();
  private assets: AssetRecord[] = [];
  private audit: AuditEvent[] = [];
  private overrides: OverrideRecord[] = [];
  private profiles = new Map<string, StyleProfile[]>();

  ensureJob(meta: JobMeta): void {
    if (!this.jobs.has(meta.id)) this.jobs.set(meta.id, meta);
  }
  getJob(id: string): JobMeta | undefined {
    return this.jobs.get(id);
  }
  listItems(jobId: string): JobItem[] {
    return [...this.items.values()].filter((i) => i.jobId === jobId).map((i) => structuredClone(i));
  }
  putItem(item: JobItem): void {
    this.items.set(`${item.jobId}\0${item.assetId}`, structuredClone(item));
  }

  putAsset(asset: AssetRecord): void {
    if (!this.assets.some((a) => a.fingerprint === asset.fingerprint && a.path === asset.path)) this.assets.push(structuredClone(asset));
  }
  findAssetsByFingerprint(fingerprint: string): AssetRecord[] {
    return this.assets.filter((a) => a.fingerprint === fingerprint).map((a) => structuredClone(a));
  }
  appendAudit(event: AuditEvent): void {
    this.audit.push(structuredClone(event));
  }
  listAudit(filter?: { jobId?: string }): AuditEvent[] {
    return this.audit.filter((e) => !filter?.jobId || e.jobId === filter.jobId).map((e) => structuredClone(e));
  }
  recordOverrides(overrides: readonly OverrideRecord[]): void {
    this.overrides.push(...structuredClone([...overrides]));
  }
  listOverrides(jobId: string): OverrideRecord[] {
    return this.overrides.filter((o) => o.jobId === jobId).map((o) => structuredClone(o));
  }
  saveProfile(profile: StyleProfile): void {
    const versions = this.profiles.get(profile.id) ?? [];
    if (!versions.some((p) => p.version === profile.version)) this.profiles.set(profile.id, [...versions, structuredClone(profile)]);
  }
  loadProfile(id: string, version?: number): StyleProfile | undefined {
    const versions = this.profiles.get(id) ?? [];
    const found = version === undefined ? versions.reduce<StyleProfile | undefined>((a, p) => (!a || p.version > a.version ? p : a), undefined) : versions.find((p) => p.version === version);
    return found && structuredClone(found);
  }
}
