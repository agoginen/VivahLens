import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createSecretStore, SecretStoreError, verifyEntitlement, VivahError, writePrivateFile, type Entitlement, type EntitlementStatus, type SecretStore, type Suspension } from "@vivahlens/core";
import { dataDir } from "./paths.js";

/** The refresh token sits either in the system's secret store (the default where there is one) or, failing that, in the private license file. */
const FileSchema = z.object({
  server: z.string().url(),
  activationId: z.string(),
  entitlementToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  refreshTokenIn: z.enum(["file", "store"]).default("file"),
});

export interface StoredLicense {
  server: string;
  activationId: string;
  refreshToken: string;
  entitlementToken: string;
}
/** What is kept in the license file; the refresh token is fetched separately, only when it is needed. */
export type LicenseFields = Omit<StoredLicense, "refreshToken">;

const SECRET_SERVICE = "vivahlens";
const SECRET_ACCOUNT = "refresh-token";

/**
 * Where the activation lives on this machine. The license file is readable by this user only (restricted with icacls on
 * Windows, where a file mode does nothing). The refresh token, which can mint new entitlements, goes into the system's
 * own secret store (Windows DPAPI, the macOS keychain, the Linux Secret Service) when there is one, and stays in the
 * private file only where there is none. `VIVAH_SECRET_STORE=none` keeps it in the file always.
 */
export class LicenseStore {
  constructor(
    readonly dir: string,
    private readonly opts: { secrets?: () => Promise<SecretStore | undefined> } = {},
  ) {}

  static fromEnv(env: Record<string, string | undefined>): LicenseStore {
    const dir = dataDir(env);
    return new LicenseStore(dir, env.VIVAH_SECRET_STORE === "none" ? {} : { secrets: () => createSecretStore({ dir: path.join(dir, "secrets") }) });
  }

  private file = (name: string) => path.join(this.dir, name);

  private async readFile(): Promise<z.infer<typeof FileSchema> | undefined> {
    try {
      return FileSchema.parse(JSON.parse(await fs.readFile(this.file("license.json"), "utf8")));
    } catch {
      return undefined;
    }
  }

  /** The license without its refresh token: enough to check the entitlement, and no call to the secret store. */
  async readFields(): Promise<LicenseFields | undefined> {
    const raw = await this.readFile();
    return raw && { server: raw.server, activationId: raw.activationId, entitlementToken: raw.entitlementToken };
  }

  /** The refresh token, from wherever it was kept. Undefined when it is gone (the machine must be activated again). */
  async readRefreshToken(): Promise<string | undefined> {
    const raw = await this.readFile();
    if (!raw) return undefined;
    if (raw.refreshTokenIn === "file") return raw.refreshToken;
    const secrets = await this.opts.secrets?.();
    if (!secrets) return undefined;
    return secrets.get(SECRET_SERVICE, SECRET_ACCOUNT);
  }

  async read(): Promise<StoredLicense | undefined> {
    const fields = await this.readFields();
    const refreshToken = fields && (await this.readRefreshToken());
    return fields && refreshToken ? { ...fields, refreshToken } : undefined;
  }

  /** Keeps the license; returns where the refresh token went. A secret store that cannot be used is not an error: the private file takes over. */
  async write(license: StoredLicense): Promise<"store" | "file"> {
    await fs.mkdir(this.dir, { recursive: true });
    let where: "store" | "file" = "file";
    try {
      const secrets = await this.opts.secrets?.();
      if (secrets) {
        await secrets.set(SECRET_SERVICE, SECRET_ACCOUNT, license.refreshToken);
        where = "store";
      }
    } catch (err) {
      if (!(err instanceof SecretStoreError)) throw err;
    }
    const content = { server: license.server, activationId: license.activationId, entitlementToken: license.entitlementToken, ...(where === "store" ? { refreshTokenIn: "store" } : { refreshToken: license.refreshToken, refreshTokenIn: "file" }) };
    await writePrivateFile(this.file("license.json"), JSON.stringify(content));
    return where;
  }

  /** Replaces the entitlement token and leaves the refresh token wherever it is. */
  async updateEntitlement(entitlementToken: string): Promise<void> {
    const raw = await this.readFile();
    if (!raw) throw new VivahError("ENTITLEMENT_INVALID", "This computer is not activated.");
    await writePrivateFile(this.file("license.json"), JSON.stringify({ ...raw, entitlementToken }));
  }

  async clear(): Promise<void> {
    await fs.rm(this.file("license.json"), { force: true });
    try {
      await (await this.opts.secrets?.())?.delete(SECRET_SERVICE, SECRET_ACCOUNT);
    } catch (err) {
      if (!(err instanceof SecretStoreError)) throw err;
    }
  }

  /** A random id created once per machine; deliberately not derived from hardware. */
  async deviceId(): Promise<string> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file("device.json"), "utf8")) as { deviceId?: string };
      if (saved.deviceId) return saved.deviceId;
    } catch {
      // first run
    }
    const deviceId = randomUUID();
    await fs.mkdir(this.dir, { recursive: true });
    await writePrivateFile(this.file("device.json"), JSON.stringify({ deviceId }));
    return deviceId;
  }
}

class Unreachable extends Error {}

interface ServerReply {
  status: number;
  json: { code?: string; detail?: string; entitlementToken?: string; refreshToken?: string; activationId?: string; expiresAt?: number } | undefined;
}

async function callServer(fetchImpl: typeof fetch, server: string, route: string, opts: { token?: string; body?: unknown } = {}): Promise<ServerReply> {
  let res: Response;
  try {
    res = await fetchImpl(`${server.replace(/\/+$/, "")}${route}`, {
      method: "POST",
      headers: { ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Unreachable();
  }
  const text = await res.text();
  let json: ServerReply["json"];
  try {
    json = text ? (JSON.parse(text) as ServerReply["json"]) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

function refusal(reply: ServerReply): VivahError {
  const message = reply.json?.detail ?? `The license server answered ${reply.status}.`;
  if (reply.status === 402) return new VivahError("ENTITLEMENT_EXPIRED", "Your subscription is not active. Renew it to keep editing.");
  if (reply.status === 429) return new VivahError("ENTITLEMENT_INVALID", "Too many attempts. Wait a minute and try again.", true);
  return new VivahError("ENTITLEMENT_INVALID", message);
}

export interface ActivateOptions {
  store: LicenseStore;
  server: string;
  licenseKey: string;
  deviceName: string;
  fetch?: typeof fetch;
}

/** Binds this machine to a license key and keeps the refresh token and first entitlement. */
export async function activate(opts: ActivateOptions): Promise<StoredLicense & { refreshTokenIn: "store" | "file" }> {
  const fetchImpl = opts.fetch ?? fetch;
  let reply: ServerReply;
  try {
    reply = await callServer(fetchImpl, opts.server, "/v1/activate", {
      body: { licenseKey: opts.licenseKey, deviceId: await opts.store.deviceId(), deviceName: opts.deviceName },
    });
  } catch (err) {
    if (err instanceof Unreachable) throw new VivahError("ENTITLEMENT_INVALID", `Could not reach the license server at ${opts.server}. Check your connection.`);
    throw err;
  }
  const { entitlementToken, refreshToken, activationId } = reply.json ?? {};
  if (reply.status !== 200 || !entitlementToken || !refreshToken || !activationId) throw refusal(reply);
  const license: StoredLicense = { server: opts.server.replace(/\/+$/, ""), activationId, refreshToken, entitlementToken };
  const refreshTokenIn = await opts.store.write(license);
  return { ...license, refreshTokenIn };
}

/** Frees this machine's slot on the server (best effort when offline) and forgets the local activation. */
export async function deactivate(opts: { store: LicenseStore; fetch?: typeof fetch }): Promise<{ serverNotified: boolean }> {
  const stored = await opts.store.readFields();
  if (!stored) throw new VivahError("ENTITLEMENT_INVALID", "This computer is not activated.");
  let notified = false;
  try {
    const token = await opts.store.readRefreshToken();
    if (token) {
      const reply = await callServer(opts.fetch ?? fetch, stored.server, "/v1/deactivate", { token });
      notified = reply.status === 204 || reply.status === 401;
    }
  } catch {
    // Offline: the local activation is still removed; the slot can be freed from the account later.
  }
  await opts.store.clear();
  return { serverNotified: notified };
}

export interface CurrentEntitlement {
  entitlement: Entitlement;
  status: EntitlementStatus;
  /** A fresh token was fetched from the server just now. */
  refreshed: boolean;
  /** The server could not be reached, so the cached token was used. */
  offline: boolean;
  /** The server said the subscription ended or this device was removed. Believed at once, even if the saved token still looks valid. */
  suspended?: Suspension;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CurrentEntitlementOptions {
  store: LicenseStore;
  publicKey: string;
  now?: () => number;
  fetch?: typeof fetch;
  /** Refresh when less than this much validity is left (default one day), so a photographer is never caught offline mid-job. */
  refreshWithinMs?: number;
}

/**
 * The entitlement to enforce on this machine: the cached token while it is comfortably valid, a refreshed one when
 * it is near expiry and the server is reachable, and the cached one when the server is down. A server that says
 * "subscription inactive" or "device deactivated" is believed immediately: the result is marked `suspended`, which
 * pauses editing but leaves export, delivery and undo available (`accessFor`).
 */
export async function currentEntitlement(opts: CurrentEntitlementOptions): Promise<CurrentEntitlement> {
  const now = opts.now ?? Date.now;
  const stored = await opts.store.readFields();
  if (!stored) throw new VivahError("ENTITLEMENT_INVALID", "This computer is not activated. Run `vivah activate --server <url> --key <license key>`.");

  const cached = verifyEntitlement(stored.entitlementToken, opts.publicKey, now());
  if (cached.status === "active" && cached.entitlement.expiresAt - now() > (opts.refreshWithinMs ?? DAY_MS)) {
    return { ...cached, refreshed: false, offline: false };
  }

  // The refresh token is only needed now, so a comfortably valid license never touches the secret store.
  const refreshToken = await opts.store.readRefreshToken();
  if (!refreshToken) throw new VivahError("ENTITLEMENT_INVALID", "This computer's saved sign-in is missing. Run `vivah activate` again.");
  let reply: ServerReply;
  try {
    reply = await callServer(opts.fetch ?? fetch, stored.server, "/v1/refresh", { token: refreshToken });
  } catch (err) {
    if (err instanceof Unreachable) return { ...cached, refreshed: false, offline: true };
    throw err;
  }
  if (reply.status === 200 && reply.json?.entitlementToken) {
    const fresh = verifyEntitlement(reply.json.entitlementToken, opts.publicKey, now());
    await opts.store.updateEntitlement(reply.json.entitlementToken);
    return { ...fresh, refreshed: true, offline: false };
  }
  if (reply.status === 401) return { ...cached, refreshed: false, offline: false, suspended: "device" };
  if (reply.status === 402) return { ...cached, refreshed: false, offline: false, suspended: "subscription" };
  // Rate limits and server errors must not lock out a photographer who holds a valid cached token.
  return { ...cached, refreshed: false, offline: true };
}
