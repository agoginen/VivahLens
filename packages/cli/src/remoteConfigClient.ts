import { promises as fs } from "node:fs";
import path from "node:path";
import { SignedDocumentExpired, verifyRemoteConfig, VivahError, adapterStatus, type AdapterStatus, type PinnedKeys, type RemoteConfig } from "@vivahlens/core";
import { fetchSigned, pinnedKeys, TrustState, Unreachable } from "./signedClient.js";

export interface RemoteConfigResult {
  config?: RemoteConfig;
  /** Something the person should know: the settings were refused, or could not be used. */
  note?: string;
}

interface CacheFile {
  fetchedAt: number;
  bytesBase64: string;
  signature: unknown;
}

const DAY = 24 * 60 * 60 * 1000;

async function readCache(file: string): Promise<CacheFile | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Partial<CacheFile>;
    return typeof raw.fetchedAt === "number" && typeof raw.bytesBase64 === "string" ? { fetchedAt: raw.fetchedAt, bytesBase64: raw.bytesBase64, signature: raw.signature } : undefined;
  } catch {
    return undefined;
  }
}

export interface RemoteConfigOptions {
  env: Record<string, string | undefined>;
  dir: string;
  /** Where to fetch from; without one only what is already saved is used. */
  baseUrl?: string;
  /** Use only what is saved; contact nothing. */
  offline?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long a saved copy is used without asking again (default one day). */
  maxAgeMs?: number;
  timeoutMs?: number;
}

/**
 * The signed remote config (model prices, which editor adapters are on, in beta or switched off), or nothing when there
 * is none or it cannot be trusted. It never stands in the way: a copy is kept for a day, an unreachable server means
 * the saved copy is used, and anything that fails its signature or has run out is ignored in favour of what is built in.
 */
export async function loadRemoteConfig(opts: RemoteConfigOptions): Promise<RemoteConfigResult> {
  const now = opts.now?.() ?? Date.now();
  let pinned: PinnedKeys;
  try {
    pinned = await pinnedKeys(opts.env);
  } catch (err) {
    return { note: `Remote settings are off: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (Object.keys(pinned).length === 0) return {};

  const trust = new TrustState(opts.dir);
  const cacheFile = path.join(opts.dir, "remote-config.json");
  const cache = await readCache(cacheFile);
  const fromCache = async (): Promise<RemoteConfig | undefined> => {
    if (!cache) return undefined;
    try {
      return verifyRemoteConfig({ bytes: Buffer.from(cache.bytesBase64, "base64"), signature: cache.signature, pinned, state: (await trust.read()).config, now }).config;
    } catch {
      return undefined;
    }
  };
  const saved = await fromCache();
  if (saved && cache && now - cache.fetchedAt < (opts.maxAgeMs ?? DAY)) return { config: saved };
  if (opts.offline || !opts.baseUrl) return saved ? { config: saved } : {};

  try {
    const doc = await fetchSigned({ baseUrl: opts.baseUrl, name: "config", fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? 3000 });
    if (!doc) return saved ? { config: saved } : {};
    const { config, state } = verifyRemoteConfig({ bytes: doc.bytes, signature: doc.signature, pinned, state: (await trust.read()).config, now });
    await fs.mkdir(opts.dir, { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify({ fetchedAt: now, bytesBase64: doc.bytes.toString("base64"), signature: doc.signature } satisfies CacheFile), "utf8");
    await trust.save((record) => {
      record.config = state;
    });
    return { config };
  } catch (err) {
    if (err instanceof Unreachable) return saved ? { config: saved } : {};
    if (err instanceof SignedDocumentExpired) return { ...(saved && { config: saved }), note: "The remote settings are out of date, so what is built in is used." };
    if (err instanceof VivahError) return { ...(saved && { config: saved }), note: `The remote settings were refused (${err.message}); what is built in is used.` };
    throw err;
  }
}

/**
 * Adapters that ship as beta because they have not been run against the real editor yet: the Lightroom plugin, the
 * RawTherapee profile keys and the darktable sidecar layouts were all written from documentation and source. A signed
 * remote config can promote one to stable, or switch it off, without a new release (plan §7.6).
 */
export const BUILT_IN_STAGES: Readonly<Record<string, AdapterStatus>> = {
  "lightroom-classic": { stage: "beta", notice: "The plugin has not been checked against every Lightroom Classic version yet; look at the result before relying on it." },
  rawtherapee: { stage: "beta", notice: "Its profile keys have not been checked against a RawTherapee install yet; look at the result before relying on it." },
  darktable: { stage: "beta", notice: "Written from darktable's source and not yet run against a real install: it sets exposure and crop only; check the result in darktable." },
};

/** What to do about an adapter the remote config (or the build) has switched off or marked beta: stop with the reason, or say so and go on. */
export function adapterNotice(config: RemoteConfig | undefined, adapterId: string): { blocked?: string; note?: string } {
  const explicit = config?.adapters !== undefined && Object.hasOwn(config.adapters, adapterId);
  const status = explicit ? adapterStatus(config, adapterId) : Object.hasOwn(BUILT_IN_STAGES, adapterId) ? BUILT_IN_STAGES[adapterId]! : adapterStatus(config, adapterId);
  if (status.stage === "disabled") return { blocked: status.notice ?? `"${adapterId}" is switched off for now.` };
  if (status.stage === "beta") return { note: `"${adapterId}" is in beta.${status.notice ? ` ${status.notice}` : ""}` };
  return {};
}
