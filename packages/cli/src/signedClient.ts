import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { VivahError, type PinnedKeys, type SequenceState } from "@vivahlens/core";
import { dataDir } from "./paths.js";

/** The public keys a shipped build trusts for release manifests and the remote config, by key id. Empty in a development build. */
export const EMBEDDED_KEYS: Record<string, string> = {};

/**
 * The keys to trust. A shipped build uses only the keys built into it. A development build reads `VIVAH_UPDATE_KEYS`: a
 * JSON object of key id to base64 public key, or the path of a file holding one. With neither there is nothing to
 * trust, so signed documents are not fetched at all.
 */
export async function pinnedKeys(env: Record<string, string | undefined>): Promise<PinnedKeys> {
  if (Object.keys(EMBEDDED_KEYS).length > 0) return EMBEDDED_KEYS;
  const setting = env.VIVAH_UPDATE_KEYS?.trim();
  if (!setting) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(setting.startsWith("{") ? setting : await fs.readFile(setting, "utf8"));
  } catch (err) {
    throw new VivahError("SIGNED_DOCUMENT_INVALID", `VIVAH_UPDATE_KEYS is not usable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Object.values(parsed).some((v) => typeof v !== "string")) {
    throw new VivahError("SIGNED_DOCUMENT_INVALID", "VIVAH_UPDATE_KEYS must be a JSON object of key id to base64 public key");
  }
  return parsed as Record<string, string>;
}

/** This installation's random id, used only on this computer to place it in a staged rollout. It is never sent anywhere. */
export async function installId(dir: string): Promise<string> {
  const file = path.join(dir, "install-id");
  try {
    const existing = (await fs.readFile(file, "utf8")).trim();
    if (/^[0-9a-f]{32}$/.test(existing)) return existing;
  } catch {
    // Not made yet.
  }
  const fresh = randomBytes(16).toString("hex");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, fresh, "utf8");
  return fresh;
}

export interface TrustRecord {
  /** The newest manifest accepted for each channel. */
  manifests: Record<string, SequenceState>;
  /** The newest remote config accepted. */
  config?: SequenceState;
}

const validState = (v: unknown): v is SequenceState => !!v && typeof v === "object" && Number.isInteger((v as SequenceState).lastSequence) && ((v as SequenceState).lastSha256 === undefined || typeof (v as SequenceState).lastSha256 === "string");

/** What this computer has already accepted, so an older signed document cannot be replayed to it. */
export class TrustState {
  constructor(readonly dir: string) {}

  get file(): string {
    return path.join(this.dir, "update-state.json");
  }

  async read(): Promise<TrustRecord> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<TrustRecord>;
      const manifests = Object.fromEntries(Object.entries(raw.manifests ?? {}).filter(([, v]) => validState(v)));
      return { manifests, ...(validState(raw.config) && { config: raw.config }) };
    } catch {
      return { manifests: {} };
    }
  }

  async save(change: (record: TrustRecord) => void): Promise<void> {
    const record = await this.read();
    change(record);
    await fs.mkdir(this.dir, { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(record, null, 2), "utf8");
    await fs.rename(temp, this.file);
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_DOCUMENT_BYTES = 200 * 1024;

/** The text of a response, refusing to read more than `max` bytes however long the server keeps sending. */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new VivahError("SIGNED_DOCUMENT_INVALID", "The document is larger than any real one");
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > max) throw new VivahError("SIGNED_DOCUMENT_INVALID", "The document is larger than any real one");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface FetchedDocument {
  bytes: Buffer;
  signature: unknown;
}

export class Unreachable extends Error {}

/**
 * Downloads a signed document and its signature from a server. The server is not trusted: this only fetches, and the
 * caller must verify before reading anything in it. Plain http is allowed only to this computer (tests, local tools).
 * Returns undefined when nothing has been published under that name; throws `Unreachable` when the server cannot be
 * reached or fails.
 */
export async function fetchSigned(opts: { baseUrl: string; name: string; fetch?: typeof fetch; timeoutMs?: number }): Promise<FetchedDocument | undefined> {
  const base = new URL(opts.baseUrl);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && LOOPBACK.has(base.hostname))) {
    throw new VivahError("SIGNED_DOCUMENT_INVALID", `${opts.baseUrl} must be an https address`);
  }
  const get = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 4000;
  const one = async (suffix: string): Promise<Buffer | undefined> => {
    let res: Response;
    try {
      res = await get(new URL(`/v1/documents/${opts.name}${suffix}`, base), { signal: AbortSignal.timeout(timeout), headers: { accept: "*/*" } });
    } catch (err) {
      throw new Unreachable(err instanceof Error ? err.message : String(err));
    }
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Unreachable(`the server answered ${res.status}`);
    try {
      return await readCapped(res, MAX_DOCUMENT_BYTES);
    } catch (err) {
      if (err instanceof VivahError) throw err;
      throw new Unreachable(err instanceof Error ? err.message : String(err));
    }
  };
  const [bytes, sig] = await Promise.all([one(""), one(".sig")]);
  if (!bytes || !sig) return undefined;
  let signature: unknown;
  try {
    signature = JSON.parse(sig.toString("utf8"));
  } catch {
    throw new VivahError("SIGNED_DOCUMENT_INVALID", "The signature file is not valid JSON");
  }
  return { bytes, signature };
}

/** Where signed documents come from: the update address, else the license server this computer was activated with. */
export async function documentServer(env: Record<string, string | undefined>, explicit?: string, activatedServer?: () => Promise<string | undefined>): Promise<string | undefined> {
  return explicit ?? env.VIVAH_UPDATE_URL ?? (await activatedServer?.());
}

export const trustDir = (env: Record<string, string | undefined>): string => dataDir(env);
