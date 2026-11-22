import type { EditRecipe } from "../recipe/editRecipe.js";
import type { OutboundEvent } from "../privacy/outbound.js";
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

/** A recipe that was proposed or approved for a file, kept so the same file is never asked about twice (and offline runs have something to use). */
export interface RecipeRecord {
  /** `recipeHash` of the recipe. */
  hash: string;
  /** Content fingerprint of the file the recipe is for. */
  fingerprint: string;
  profileId: string;
  profileVersion: number;
  recipe: EditRecipe;
  /** A model's proposal, or what the reviewer settled on (always trusted, whatever the style version). */
  source: "llm" | "override";
  confidence?: number;
  jobId: string;
  assetId: string;
  createdAt: string;
}

/** What an adapter replaced, so the change can be taken back (plan §7g): the file written and where its previous content was saved. */
export interface UndoEntry {
  id?: number;
  jobId: string;
  assetId: string;
  adapterId: string;
  /** The file the adapter wrote. */
  target: string;
  /** A copy of what was at `target` before; absent when the file did not exist, so undoing deletes it. */
  backup?: string;
  /** SHA-256 of what the adapter wrote; an undo leaves the file alone if its content no longer matches. */
  writtenSha256?: string;
  at: string;
  undoneAt?: string;
}

/** A finished file handed over to its destination (plan §2.8 `delivered`). */
export interface DeliveryRecord {
  jobId: string;
  assetId: string;
  destination: string;
  at: string;
  bytes?: number;
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
  putRecipe(record: RecipeRecord): void;
  /** The reviewer's latest recipe for this file under this profile (any version), else the model's for exactly this version. */
  findRecipe(fingerprint: string, profileId: string, profileVersion: number): RecipeRecord | undefined;
  recordUndo(entry: Omit<UndoEntry, "id">): void;
  /** Entries of a job, newest first. */
  listUndo(jobId: string, opts?: { pending?: boolean }): UndoEntry[];
  markUndone(id: number, at: string): void;
  recordOutbound(event: OutboundEvent): void;
  listOutbound(filter?: { jobId?: string }): OutboundEvent[];
  recordDelivery(delivery: DeliveryRecord): void;
  listDeliveries(jobId: string): DeliveryRecord[];
}

export type Store = JobStore & LibraryStore;

/** The reviewer's newest recipe for the profile, else the model's newest for this exact version. Shared by the stores. */
export function pickRecipe(records: readonly RecipeRecord[], fingerprint: string, profileId: string, profileVersion: number): RecipeRecord | undefined {
  const mine = records.filter((r) => r.fingerprint === fingerprint && r.profileId === profileId);
  const newest = (list: RecipeRecord[]) => list.reduce<RecipeRecord | undefined>((a, r) => (!a || r.createdAt >= a.createdAt ? r : a), undefined);
  return newest(mine.filter((r) => r.source === "override")) ?? newest(mine.filter((r) => r.source === "llm" && r.profileVersion === profileVersion));
}

export class MemoryStore implements Store {
  private jobs = new Map<string, JobMeta>();
  private items = new Map<string, JobItem>();
  private assets: AssetRecord[] = [];
  private audit: AuditEvent[] = [];
  private overrides: OverrideRecord[] = [];
  private profiles = new Map<string, StyleProfile[]>();
  private recipes: RecipeRecord[] = [];
  private undo: UndoEntry[] = [];
  private outbound: OutboundEvent[] = [];
  private deliveries: DeliveryRecord[] = [];

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

  putRecipe(record: RecipeRecord): void {
    this.recipes.push(structuredClone(record));
  }
  findRecipe(fingerprint: string, profileId: string, profileVersion: number): RecipeRecord | undefined {
    const found = pickRecipe(this.recipes, fingerprint, profileId, profileVersion);
    return found && structuredClone(found);
  }
  recordUndo(entry: Omit<UndoEntry, "id">): void {
    this.undo.push({ ...structuredClone(entry), id: this.undo.length + 1 });
  }
  listUndo(jobId: string, opts?: { pending?: boolean }): UndoEntry[] {
    return this.undo
      .filter((u) => u.jobId === jobId && (!opts?.pending || !u.undoneAt))
      .map((u) => structuredClone(u))
      .reverse();
  }
  markUndone(id: number, at: string): void {
    const entry = this.undo.find((u) => u.id === id);
    if (entry) entry.undoneAt = at;
  }
  recordOutbound(event: OutboundEvent): void {
    this.outbound.push(structuredClone(event));
  }
  listOutbound(filter?: { jobId?: string }): OutboundEvent[] {
    return this.outbound.filter((e) => !filter?.jobId || e.jobId === filter.jobId).map((e) => structuredClone(e));
  }
  recordDelivery(delivery: DeliveryRecord): void {
    this.deliveries.push(structuredClone(delivery));
  }
  listDeliveries(jobId: string): DeliveryRecord[] {
    return this.deliveries.filter((d) => d.jobId === jobId).map((d) => structuredClone(d));
  }
}
