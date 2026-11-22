import { compareSemver, pickRelease, SignedDocumentExpired, verifyManifest, type Channel, type Offer, type PinnedKeys } from "@vivahlens/core";
import { fetchSigned, TrustState, Unreachable } from "./signedClient.js";

export type UpdateStatus = "available" | "current" | "none-published" | "stale" | "unreachable";

export interface UpdateCheck {
  status: UpdateStatus;
  currentVersion: string;
  channel: Channel;
  offer?: Offer & { channel: Channel };
  /** Why the check could not finish, when it could not. */
  detail?: string;
}

/** `<os>-<arch>` as release manifests name their artifacts. */
export function updateTarget(platform: string = process.platform, arch: string = process.arch): string {
  const os = ({ win32: "windows", darwin: "darwin", linux: "linux" } as Record<string, string>)[platform] ?? platform;
  const cpu = ({ x64: "x86_64", arm64: "aarch64", ia32: "i686", arm: "armv7" } as Record<string, string>)[arch] ?? arch;
  return `${os}-${cpu}`;
}

export interface CheckOptions {
  baseUrl: string;
  channel: Channel;
  currentVersion: string;
  installId: string;
  target: string;
  pinned: PinnedKeys;
  state: TrustState;
  fetch?: typeof fetch;
  now?: number;
  timeoutMs?: number;
}

/**
 * Looks for a newer release: fetches the channel's signed manifest (and the stable one too when on beta or alpha, since a
 * channel cannot be a reason to miss a stable release), verifies each, remembers the newest accepted, and picks what this
 * install is eligible for. A manifest that fails its signature check is an error, not "no update"; one that has merely
 * run out, or a server that cannot be reached, is reported softly and changes nothing.
 */
export async function checkForUpdates(opts: CheckOptions): Promise<UpdateCheck> {
  const channels: Channel[] = opts.channel === "stable" ? ["stable"] : [opts.channel, "stable"];
  const offers: (Offer & { channel: Channel })[] = [];
  let reached = false;
  let published = false;
  let stale = false;
  let detail: string | undefined;

  for (const channel of channels) {
    let doc;
    try {
      doc = await fetchSigned({ baseUrl: opts.baseUrl, name: `updates-${channel}`, fetch: opts.fetch, timeoutMs: opts.timeoutMs });
      reached = true;
    } catch (err) {
      if (err instanceof Unreachable) {
        detail = err.message;
        continue;
      }
      throw err;
    }
    if (!doc) continue;
    published = true;
    const trust = await opts.state.read();
    let verified;
    try {
      verified = verifyManifest({ bytes: doc.bytes, signature: doc.signature, pinned: opts.pinned, expectedChannel: channel, state: trust.manifests[channel], now: opts.now });
    } catch (err) {
      if (err instanceof SignedDocumentExpired) {
        stale = true;
        continue;
      }
      throw err;
    }
    await opts.state.save((record) => {
      record.manifests[channel] = verified.state;
    });
    const offer = pickRelease({ manifest: verified.manifest, currentVersion: opts.currentVersion, installId: opts.installId, target: opts.target });
    if (offer) offers.push({ ...offer, channel });
  }

  const base = { currentVersion: opts.currentVersion, channel: opts.channel };
  if (offers.length > 0) {
    // Getting off a withdrawn version comes before any newer one.
    const best = offers.find((o) => o.kind === "rollback") ?? offers.sort((a, b) => compareSemver(b.release.version, a.release.version))[0]!;
    return { ...base, status: "available", offer: best };
  }
  if (!reached) return { ...base, status: "unreachable", ...(detail && { detail }) };
  if (stale) return { ...base, status: "stale" };
  return { ...base, status: published ? "current" : "none-published" };
}

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** What `vivah update` tells the person. */
export function describeUpdate(check: UpdateCheck): string[] {
  const { currentVersion, channel } = check;
  switch (check.status) {
    case "available": {
      const { release, artifact, kind } = check.offer!;
      return [
        kind === "rollback"
          ? `You have ${currentVersion}, which has been withdrawn. Go back to ${release.version}.`
          : `Version ${release.version} is available (you have ${currentVersion}; channel ${check.offer!.channel}).`,
        ...(release.notes ? [release.notes] : []),
        `Download: ${artifact.url}`,
        `Check the file before you run it: SHA-256 ${artifact.sha256}, ${kb(artifact.size)}.`,
        "VivahLens does not replace itself yet: download the new version and install it over this one.",
      ];
    }
    case "current":
      return [`You are up to date (${currentVersion}, channel ${channel}).`];
    case "none-published":
      return [`No update information has been published for the ${channel} channel yet.`];
    case "stale":
      return ["The update information is out of date, so it was not used. It will work again once a fresh one is published."];
    case "unreachable":
      return [`Could not check for updates${check.detail ? ` (${check.detail})` : ""}. Nothing was changed.`];
  }
}
