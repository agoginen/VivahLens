import { promises as fs } from "node:fs";
import path from "node:path";
import { VivahError } from "../errors.js";
import { ensurePrivateDir, writePrivateFile } from "./privateFile.js";
import { nodeRunner, type Runner } from "./runner.js";

export type SecretStoreErrorKind = "unavailable" | "corrupt" | "failed" | "invalid-name";

export class SecretStoreError extends VivahError {
  constructor(
    readonly kind: SecretStoreErrorKind,
    message: string,
  ) {
    super("SECRET_STORE_UNAVAILABLE", message);
    this.name = "SecretStoreError";
  }
}

export interface SecretStore {
  readonly backend: "windows-dpapi" | "macos-keychain" | "secret-service" | "private-file" | "memory";
  /** The secret, or undefined when there is none. Throws SecretStoreError when the store cannot be used or what it holds is damaged. */
  get(service: string, account: string): Promise<string | undefined>;
  set(service: string, account: string, secret: string): Promise<void>;
  /** True when something was removed. */
  delete(service: string, account: string): Promise<boolean>;
}

/** Names are used in file names and in command lines, so they stay plain. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function checkNames(service: string, account: string): void {
  if (!NAME.test(service) || !NAME.test(account)) throw new SecretStoreError("invalid-name", "A secret's service and account names may only use letters, digits, dots, dashes and underscores.");
}

/** Every backend stores printable ASCII: macOS prints non-printable secrets as hex, and secret-tool wants short valid text. */
const envelope = (secret: string): string => `v1:${Buffer.from(secret, "utf8").toString("base64")}`;

function open(stored: string): string {
  if (!stored.startsWith("v1:")) throw new SecretStoreError("corrupt", "The stored secret is not in the form this version wrote.");
  return Buffer.from(stored.slice(3), "base64").toString("utf8");
}

const DPAPI_SCRIPT = (mode: "Protect" | "Unprotect") => `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName System.Security
$ms = New-Object System.IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($ms); $in = $ms.ToArray()
$entropy = [System.Text.Encoding]::UTF8.GetBytes($env:VL_ENTROPY); $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$out = [System.Security.Cryptography.ProtectedData]::${mode}($in, $entropy, $scope)
$o = [Console]::OpenStandardOutput(); $o.Write($out, 0, $out.Length); $o.Flush()`;

export interface WindowsStoreOptions {
  /** Where the protected files go; created private. */
  dir: string;
  run?: Runner;
  powershell?: string;
  /** Overrides process.platform for the access-list steps (tests). */
  platform?: NodeJS.Platform;
}

/**
 * Windows: the secret is encrypted with DPAPI for the current user (in Windows PowerShell, which every Windows has) and the
 * result kept in a file. Other users, a copied disk and backups cannot read it; another program running as this user can,
 * as with every per-user store. The secret reaches PowerShell on its standard input, never in a command line.
 */
export class WindowsDpapiStore implements SecretStore {
  readonly backend = "windows-dpapi" as const;
  private readonly run: Runner;
  private readonly powershell: string;

  constructor(private readonly opts: WindowsStoreOptions) {
    this.run = opts.run ?? nodeRunner;
    this.powershell = opts.powershell ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  }

  private io(): { run?: Runner; platform?: NodeJS.Platform } {
    return { ...(this.opts.run && { run: this.opts.run }), ...(this.opts.platform && { platform: this.opts.platform }) };
  }

  private file(service: string, account: string): string {
    return path.join(this.opts.dir, `${service}.${account}.dpapi`);
  }

  private async transform(mode: "Protect" | "Unprotect", input: Buffer, service: string, account: string): Promise<Buffer> {
    const res = await this.run(this.powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(DPAPI_SCRIPT(mode), "utf16le").toString("base64")], {
      stdin: input,
      env: { VL_ENTROPY: `vivahlens:v1:${service}:${account}` },
      timeoutMs: 30_000,
    });
    if (res.code === 0) return res.stdout;
    if (res.startError || res.timedOut) throw new SecretStoreError("unavailable", `Windows PowerShell could not be run to protect the secret: ${res.startError ?? "timed out"}`);
    if (/The data is invalid|Key not valid for use|incorrect parameter/i.test(res.stderr)) throw new SecretStoreError("corrupt", "The stored secret cannot be opened by this Windows account (it belongs to another user, or was altered).");
    throw new SecretStoreError("failed", `Windows could not ${mode === "Protect" ? "protect" : "open"} the secret.`);
  }

  async get(service: string, account: string): Promise<string | undefined> {
    checkNames(service, account);
    let blob: Buffer;
    try {
      blob = await fs.readFile(this.file(service, account));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new SecretStoreError("failed", `The stored secret could not be read: ${(err as Error).message}`);
    }
    return open((await this.transform("Unprotect", blob, service, account)).toString("utf8"));
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    checkNames(service, account);
    const blob = await this.transform("Protect", Buffer.from(envelope(secret), "utf8"), service, account);
    await ensurePrivateDir(this.opts.dir, this.io());
    await writePrivateFile(this.file(service, account), blob, this.io());
  }

  async delete(service: string, account: string): Promise<boolean> {
    checkNames(service, account);
    const file = this.file(service, account);
    const existed = await fs.stat(file).then(() => true, () => false);
    await fs.rm(file, { force: true });
    return existed;
  }
}

const hex = (text: string): string => Buffer.from(text, "utf8").toString("hex");

/**
 * macOS: the login keychain through `/usr/bin/security`, fed on standard input (`security -i`) so the secret is never an
 * argument. Anything that can run `security` as this user can read the item while the keychain is unlocked.
 */
export class MacKeychainStore implements SecretStore {
  readonly backend = "macos-keychain" as const;
  private readonly run: Runner;
  private readonly tool: string;

  constructor(opts: { run?: Runner; tool?: string } = {}) {
    this.run = opts.run ?? nodeRunner;
    this.tool = opts.tool ?? "/usr/bin/security";
  }

  async get(service: string, account: string): Promise<string | undefined> {
    checkNames(service, account);
    const res = await this.run(this.tool, ["find-generic-password", "-a", account, "-s", service, "-w"], { timeoutMs: 30_000 });
    if (res.startError || res.timedOut) throw new SecretStoreError("unavailable", `The macOS keychain could not be reached: ${res.startError ?? "timed out"}`);
    if (res.code === 44) return undefined; // errSecItemNotFound
    if (res.code !== 0) throw new SecretStoreError("failed", `The macOS keychain refused to give up the secret (status ${res.code}).`);
    return open(res.stdout.toString("utf8").replace(/\n$/, ""));
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    checkNames(service, account);
    const res = await this.run(this.tool, ["-i"], { stdin: `add-generic-password -U -a ${account} -s ${service} -l ${service} -X ${hex(envelope(secret))}\n`, timeoutMs: 30_000 });
    if (res.startError || res.timedOut) throw new SecretStoreError("unavailable", `The macOS keychain could not be reached: ${res.startError ?? "timed out"}`);
    if (res.code !== 0) throw new SecretStoreError("failed", `The macOS keychain did not store the secret (status ${res.code}).`);
  }

  async delete(service: string, account: string): Promise<boolean> {
    checkNames(service, account);
    const res = await this.run(this.tool, ["delete-generic-password", "-a", account, "-s", service], { timeoutMs: 30_000 });
    if (res.startError || res.timedOut) throw new SecretStoreError("unavailable", `The macOS keychain could not be reached: ${res.startError ?? "timed out"}`);
    if (res.code === 44) return false;
    if (res.code !== 0) throw new SecretStoreError("failed", `The macOS keychain did not remove the secret (status ${res.code}).`);
    return true;
  }
}

/**
 * Linux: the desktop's Secret Service (GNOME Keyring, KWallet, KeePassXC) through `secret-tool`. With no Secret Service
 * (a server, a container) it reports "unavailable" rather than keeping the secret somewhere weaker.
 */
export class SecretServiceStore implements SecretStore {
  readonly backend = "secret-service" as const;
  private readonly run: Runner;
  private readonly tool: string;

  constructor(opts: { run?: Runner; tool?: string } = {}) {
    this.run = opts.run ?? nodeRunner;
    this.tool = opts.tool ?? "secret-tool";
  }

  /** secret-tool uses exit 1 both for "nothing there" (silent) and for a broken backend (with a message). */
  private classify(res: Awaited<ReturnType<Runner>>): "ok" | "absent" {
    if (res.startError || res.timedOut) throw new SecretStoreError("unavailable", `The desktop keyring could not be reached: ${res.startError ?? "timed out"}`);
    if (res.code === 0) return "ok";
    if (res.code === 1 && res.stderr.trim() === "") return "absent";
    throw new SecretStoreError("unavailable", `The desktop keyring is not available: ${res.stderr.trim().slice(0, 200) || `secret-tool exited ${res.code}`}`);
  }

  async get(service: string, account: string): Promise<string | undefined> {
    checkNames(service, account);
    const res = await this.run(this.tool, ["lookup", "service", service, "account", account], { timeoutMs: 15_000 });
    return this.classify(res) === "absent" ? undefined : open(res.stdout.toString("utf8").replace(/\n$/, ""));
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    checkNames(service, account);
    const res = await this.run(this.tool, ["store", "--label", `VivahLens ${service}/${account}`, "service", service, "account", account], { stdin: envelope(secret), timeoutMs: 15_000 });
    if (this.classify(res) === "absent") throw new SecretStoreError("failed", "The desktop keyring did not store the secret.");
  }

  async delete(service: string, account: string): Promise<boolean> {
    checkNames(service, account);
    const had = (await this.get(service, account)) !== undefined;
    const res = await this.run(this.tool, ["clear", "service", service, "account", account], { timeoutMs: 15_000 });
    this.classify(res);
    return had;
  }

  /** Whether there is a Secret Service to talk to: asking for something that cannot exist must end with silence, not an error. */
  async probe(): Promise<boolean> {
    try {
      const res = await this.run(this.tool, ["lookup", "service", "vivahlens", "account", "__probe__"], { timeoutMs: 15_000 });
      return this.classify(res) === "absent" || res.code === 0;
    } catch {
      return false;
    }
  }
}

/** Kept in the process only; for tests and for runs that must not leave anything behind. */
export class MemorySecretStore implements SecretStore {
  readonly backend = "memory" as const;
  private readonly values = new Map<string, string>();

  async get(service: string, account: string): Promise<string | undefined> {
    checkNames(service, account);
    return this.values.get(`${service}/${account}`);
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    checkNames(service, account);
    this.values.set(`${service}/${account}`, secret);
  }

  async delete(service: string, account: string): Promise<boolean> {
    checkNames(service, account);
    return this.values.delete(`${service}/${account}`);
  }
}

/** A private folder of files, the fallback where the system has no store. Only as safe as the account's own files are. */
export class PrivateFileSecretStore implements SecretStore {
  readonly backend = "private-file" as const;

  constructor(private readonly opts: { dir: string; run?: Runner }) {}

  private file(service: string, account: string): string {
    return path.join(this.opts.dir, `${service}.${account}.secret`);
  }

  async get(service: string, account: string): Promise<string | undefined> {
    checkNames(service, account);
    try {
      return open((await fs.readFile(this.file(service, account), "utf8")).trim());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err instanceof SecretStoreError ? err : new SecretStoreError("failed", `The stored secret could not be read: ${(err as Error).message}`);
    }
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    checkNames(service, account);
    const io = this.opts.run ? { run: this.opts.run } : {};
    await ensurePrivateDir(this.opts.dir, io);
    await writePrivateFile(this.file(service, account), envelope(secret), io);
  }

  async delete(service: string, account: string): Promise<boolean> {
    checkNames(service, account);
    const existed = await fs.stat(this.file(service, account)).then(() => true, () => false);
    await fs.rm(this.file(service, account), { force: true });
    return existed;
  }
}

export interface CreateSecretStoreOptions {
  platform?: NodeJS.Platform;
  run?: Runner;
  /** Where Windows keeps its protected files and where the file fallback keeps its own. */
  dir: string;
  /** Use a private file when the system has no store (otherwise `undefined` is returned and nothing is persisted). */
  allowFileFallback?: boolean;
}

/** The system's own secret store for this computer, or what is allowed in its place. Undefined means there is nowhere safe to keep a secret. */
export async function createSecretStore(opts: CreateSecretStoreOptions): Promise<SecretStore | undefined> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? nodeRunner;
  const fallback = opts.allowFileFallback ? new PrivateFileSecretStore({ dir: opts.dir, ...(opts.run && { run: opts.run }) }) : undefined;
  if (platform === "win32") return new WindowsDpapiStore({ dir: opts.dir, run });
  if (platform === "darwin") return new MacKeychainStore({ run });
  const linux = new SecretServiceStore({ run });
  return (await linux.probe()) ? linux : fallback;
}
