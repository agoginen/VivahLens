import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { VivahError } from "../errors.js";

/**
 * Documents the app trusts without trusting the server that delivers them: the release manifest and the remote config.
 * Each is signed as its exact bytes (no canonical JSON needed) with Ed25519, and the signature is bound to the kind of
 * document by a domain string, so a signature made for one kind can never be replayed as another. The keys the app
 * trusts are pinned in the app by key id, which lets a key be rotated by shipping an app that pins the new one.
 */
export const MANIFEST_DOMAIN = "vivahlens-release-manifest-v1\n";
export const CONFIG_DOMAIN = "vivahlens-remote-config-v1\n";

export interface SignatureDoc {
  kid: string;
  alg: "Ed25519";
  /** Base64 of the 64-byte signature. */
  sig: string;
}

/** Trusted public keys by key id: the raw 32 bytes (or their base64), a PEM, or a key object. */
export type PinnedKeys = Readonly<Record<string, Uint8Array | string | KeyObject>>;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const invalid = (message: string) => new VivahError("SIGNED_DOCUMENT_INVALID", message);

/** A document that is genuine but out of date. Not an attack, so a caller can tell the person "no fresh information" rather than "tampered". */
export class SignedDocumentExpired extends VivahError {
  constructor(message: string) {
    super("SIGNED_DOCUMENT_INVALID", message);
    this.name = "SignedDocumentExpired";
  }
}

function publicKeyOf(key: Uint8Array | string | KeyObject): KeyObject {
  if (typeof key === "object" && !(key instanceof Uint8Array)) return key;
  if (typeof key === "string" && key.includes("BEGIN")) return createPublicKey(key);
  const raw = typeof key === "string" ? Buffer.from(key, "base64") : Buffer.from(key);
  if (raw.length !== 32) throw invalid("A pinned key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** The raw 32-byte public key of a key pair, as base64: what an app pins. */
export function rawPublicKey(privateKey: string | KeyObject): string {
  const key = createPublicKey(typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey);
  return Buffer.from(key.export({ type: "spki", format: "der" })).subarray(ED25519_SPKI_PREFIX.length).toString("base64");
}

export function signDocument(bytes: Uint8Array, opts: { privateKey: string | KeyObject; kid: string; domain: string }): SignatureDoc {
  const key = typeof opts.privateKey === "string" ? createPrivateKey(opts.privateKey) : opts.privateKey;
  return { kid: opts.kid, alg: "Ed25519", sig: sign(null, Buffer.concat([Buffer.from(opts.domain), bytes]), key).toString("base64") };
}

/** Throws unless `bytes` were signed for this kind of document by a pinned key. Nothing should be parsed before this passes. */
export function verifyDocument(opts: { bytes: Uint8Array; signature: unknown; pinned: PinnedKeys; domain: string }): void {
  const doc = opts.signature as Partial<SignatureDoc> | null;
  if (!doc || typeof doc !== "object" || typeof doc.kid !== "string" || doc.alg !== "Ed25519" || typeof doc.sig !== "string") throw invalid("The signature file is not in the expected format");
  // A plain object lookup would find "constructor" on the prototype chain.
  const pinned = Object.hasOwn(opts.pinned, doc.kid) ? opts.pinned[doc.kid] : undefined;
  if (pinned === undefined) throw invalid(`The document is signed with a key this app does not trust (${doc.kid.slice(0, 40)})`);
  const signature = Buffer.from(doc.sig, "base64");
  if (signature.length !== 64) throw invalid("The signature has the wrong length");
  if (!verify(null, Buffer.concat([Buffer.from(opts.domain), opts.bytes]), publicKeyOf(pinned), signature)) throw invalid("The signature does not match the document");
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** What a client remembers about the documents of one kind it has accepted, to refuse a replay of an older one. */
export interface SequenceState {
  lastSequence: number;
  lastSha256?: string;
}

/**
 * The freshness rules shared by every signed document: it must not have expired (a server cannot freeze a client on old
 * information), must not be older than one already seen (no rollback), and a sequence number cannot be reused for
 * different content. Returns the state to remember.
 */
export function acceptFresh(opts: { what: string; sequence: number; expiresAt: string; bytes: Uint8Array; state?: SequenceState; now?: number }): SequenceState {
  if (!(Date.parse(opts.expiresAt) > (opts.now ?? Date.now()))) throw new SignedDocumentExpired(`The ${opts.what} has expired; it will be accepted again when a fresh one is published`);
  const hash = sha256Hex(opts.bytes);
  const seen = opts.state;
  if (seen) {
    if (opts.sequence < seen.lastSequence) throw invalid(`The ${opts.what} is older than one already seen`);
    if (opts.sequence === seen.lastSequence && seen.lastSha256 !== undefined && seen.lastSha256 !== hash) throw invalid(`Two different ${opts.what}s carry the same sequence number`);
  }
  return { lastSequence: opts.sequence, lastSha256: hash };
}
