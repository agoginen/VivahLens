import { createHash } from "node:crypto";
import { z } from "zod";
import { VivahError } from "../errors.js";
import { MANIFEST_DOMAIN, acceptFresh, verifyDocument, type PinnedKeys, type SequenceState } from "./signedDocument.js";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Orders two semantic versions: negative when a is older. A pre-release is older than its release. Build metadata is ignored. */
export function compareSemver(a: string, b: string): number {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) throw new VivahError("SIGNED_DOCUMENT_INVALID", `"${!x ? a : b}" is not a version`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const [pa, pb] = [x[4], y[4]];
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  const [ia, ib] = [pa.split("."), pb.split(".")];
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const [p, q] = [ia[i], ib[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const version = z.string().regex(SEMVER, "not a version");
const instant = z.string().datetime({ offset: true });

const ArtifactSchema = z.object({
  url: z.string().url().startsWith("https://"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().min(1),
  /** The artifact's own signature, checked by the installer (Tauri's minisign signature). */
  tauriSignature: z.string().max(4000).optional(),
});

const ReleaseSchema = z.object({
  version,
  status: z.enum(["active", "withdrawn"]),
  /** In hundredths of a percent: 2500 is a quarter of installs. */
  rolloutBp: z.number().int().min(0).max(10_000),
  /** Only installs at or above this version are offered the release (a step that must be taken in order). */
  minFromVersion: version.optional(),
  notes: z.string().max(4000),
  /** Keyed `<os>-<arch>`, for example `windows-x86_64`. */
  artifacts: z.record(ArtifactSchema),
});

export const ManifestSchema = z.object({
  schema: z.literal(1),
  channel: z.enum(["alpha", "beta", "stable"]),
  /** Goes up with every published manifest; a client never accepts a lower one than it has seen. */
  sequence: z.number().int().min(0),
  issuedAt: instant,
  expiresAt: instant,
  releases: z.array(ReleaseSchema).max(200),
  /** Lets installs on a withdrawn version go back to a good one, and only those. */
  rollback: z.object({ from: z.array(version).min(1), to: version }).optional(),
});
export type ReleaseManifest = z.infer<typeof ManifestSchema>;
export type Release = ReleaseManifest["releases"][number];
export type Channel = ReleaseManifest["channel"];

/** What a client remembers about the manifests it has accepted, per channel, to refuse a replay of an older one. */
export type ManifestState = SequenceState;

const invalid = (message: string) => new VivahError("SIGNED_DOCUMENT_INVALID", message);

export interface VerifyManifestOptions {
  bytes: Uint8Array;
  signature: unknown;
  pinned: PinnedKeys;
  expectedChannel: Channel;
  state?: ManifestState;
  now?: number;
}

/**
 * Accepts a manifest only if it was signed by a pinned key, is for the channel that was asked for, has not run out
 * (a server cannot freeze a client on old information), and is not older than one already seen (no rollback). The
 * bytes are parsed only after the signature passes. Returns the manifest and the state to keep for next time.
 */
export function verifyManifest(opts: VerifyManifestOptions): { manifest: ReleaseManifest; state: ManifestState } {
  verifyDocument({ bytes: opts.bytes, signature: opts.signature, pinned: opts.pinned, domain: MANIFEST_DOMAIN });
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(opts.bytes).toString("utf8"));
  } catch {
    throw invalid("The manifest is not valid JSON");
  }
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) throw invalid(`The manifest is not valid: ${parsed.error.issues[0]?.path.join(".") || "body"}: ${parsed.error.issues[0]?.message}`);
  const manifest = parsed.data;
  if (manifest.channel !== opts.expectedChannel) throw invalid(`The manifest is for the "${manifest.channel}" channel, not "${opts.expectedChannel}"`);
  const state = acceptFresh({ what: "manifest", sequence: manifest.sequence, expiresAt: manifest.expiresAt, bytes: opts.bytes, state: opts.state, now: opts.now });
  return { manifest, state };
}

/**
 * Where an install falls in a staged rollout, 0 to 9999. Fixed for an install and a version, so raising the share
 * from 25% to 50% never takes the update away from anyone who already has it on offer.
 */
export function rolloutBucket(installId: string, releaseVersion: string): number {
  return createHash("sha256").update(`${installId}\n${releaseVersion}`).digest().readUInt32BE(0) % 10_000;
}

export interface PickOptions {
  manifest: ReleaseManifest;
  currentVersion: string;
  installId: string;
  /** `<os>-<arch>`, such as `windows-x86_64`. */
  target: string;
}

export interface Offer {
  release: Release;
  artifact: Release["artifacts"][string];
  /** An ordinary update, or a step back off a withdrawn version. */
  kind: "update" | "rollback";
}

/** The release this install should be offered from the manifest, if any. */
export function pickRelease(opts: PickOptions): Offer | undefined {
  const { manifest, currentVersion, installId, target } = opts;
  const offer = (release: Release | undefined, kind: Offer["kind"]): Offer | undefined => {
    const artifact = release?.artifacts[target];
    return release && artifact ? { release, artifact, kind } : undefined;
  };

  // A withdrawn version gets its installs moved back to the good one at once: that is a safety action, not a rollout.
  if (manifest.rollback?.from.includes(currentVersion)) {
    const back = offer(manifest.releases.find((r) => r.status === "active" && r.version === manifest.rollback!.to), "rollback");
    if (back) return back;
  }
  const eligible = manifest.releases
    .filter((r) => r.status === "active" && compareSemver(r.version, currentVersion) > 0)
    .filter((r) => r.minFromVersion === undefined || compareSemver(currentVersion, r.minFromVersion) >= 0)
    .filter((r) => rolloutBucket(installId, r.version) < r.rolloutBp)
    .sort((a, b) => compareSemver(b.version, a.version));
  for (const release of eligible) {
    const found = offer(release, "update");
    if (found) return found;
  }
  return undefined;
}
