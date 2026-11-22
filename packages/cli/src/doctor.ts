import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSecretStore, isCurrentUserOnly, verifyEntitlement, type ProcessRunner } from "@vivahlens/core";
import { MIN_VERSION } from "@vivahlens/adapter-darktable";
import { inspectPlugin, lightroomApplication, lightroomModulesDir, lightroomPluginSource, LIGHTROOM_HANDSHAKE_FILE, LIGHTROOM_PLUGIN_FOLDER } from "@vivahlens/adapter-lightroom";
import { LicenseStore } from "./licenseClient.js";
import { dataDir } from "./paths.js";

export type CheckStatus = "ok" | "info" | "warn" | "fail";

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it, when there is something to do. */
  fix?: string;
}

export interface DoctorDeps {
  env: Record<string, string | undefined>;
  run: ProcessRunner;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  home?: string;
  /** Overrides how the license public key is read (it is a path or the key itself). */
  readPublicKey?: (setting: string) => Promise<string>;
  now?: () => number;
}

const MIN_NODE = [22, 13] as const;

const exists = (file: string) => fs.stat(file).then(() => true, () => false);

async function version(run: ProcessRunner, command: string, args: string[]): Promise<string | undefined> {
  try {
    const res = await run(command, args);
    if (res.code !== 0) return undefined;
    return /\d+(?:\.\d+)+/.exec(res.stdout)?.[0] ?? "found";
  } catch {
    return undefined;
  }
}

/** Whether an installed darktable's version is one whose module parameters VivahLens writes. */
function darktableIsSupported(found: string): boolean {
  const [major = 0, minor = 0] = found.split(".").map(Number);
  return major > MIN_VERSION.major || (major === MIN_VERSION.major && minor >= MIN_VERSION.minor);
}

const KEYS: [provider: string, variable: string][] = [
  ["OpenAI", "OPENAI_API_KEY"],
  ["Anthropic", "ANTHROPIC_API_KEY"],
  ["Google Gemini", "GEMINI_API_KEY"],
  ["Azure OpenAI", "AZURE_OPENAI_API_KEY"],
  ["a custom endpoint", "VIVAH_API_KEY"],
];

/**
 * Looks at everything a first run depends on and says what is missing and how to fix it. Nothing here changes anything,
 * sends anything anywhere, or prints a secret (a key is reported as present or absent, never shown).
 */
export async function runDoctor(deps: DoctorDeps): Promise<Check[]> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? os.homedir();
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);

  const [major = 0, minor = 0] = (deps.nodeVersion ?? process.versions.node).split(".").map(Number);
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  add({ id: "node", title: "Node.js", status: nodeOk ? "ok" : "fail", detail: `version ${deps.nodeVersion ?? process.versions.node}${nodeOk ? "" : `; VivahLens needs ${MIN_NODE[0]}.${MIN_NODE[1]} or newer`}`, ...(!nodeOk && { fix: "Install the current LTS release from https://nodejs.org." }) });

  const data = dataDir(deps.env);
  try {
    await fs.mkdir(data, { recursive: true });
    const probe = path.join(data, `.doctor-${process.pid}`);
    await fs.writeFile(probe, "x");
    await fs.rm(probe, { force: true });
    add({ id: "data", title: "Data folder", status: "ok", detail: `${data} is writable` });
    if (platform === "win32") {
      const private_ = await isCurrentUserOnly(data).catch(() => undefined);
      if (private_ === false) add({ id: "data-private", title: "Data folder privacy", status: "info", detail: `${data} can be opened by other accounts that can open your profile folder. The files that hold secrets are restricted to you individually.` });
    }
  } catch (err) {
    add({ id: "data", title: "Data folder", status: "fail", detail: `${data} cannot be written: ${err instanceof Error ? err.message : String(err)}`, fix: "Choose another folder with VIVAH_HOME, or fix its permissions." });
  }

  // Licence: what is saved on this computer, without contacting the server.
  const store = LicenseStore.fromEnv(deps.env);
  const stored = await store.readFields().catch(() => undefined);
  if (!stored) {
    add({ id: "license", title: "Licence", status: "warn", detail: "this computer is not activated", fix: "Run `vivah activate --server <url> --key <license key>`." });
  } else if (!deps.env.VIVAH_LICENSE_PUBLIC_KEY) {
    add({ id: "license", title: "Licence", status: "info", detail: `activated with ${stored.server}; set VIVAH_LICENSE_PUBLIC_KEY to check the plan here` });
  } else {
    try {
      const key = await (deps.readPublicKey ?? ((s: string) => (s.includes("BEGIN") ? Promise.resolve(s) : fs.readFile(s, "utf8"))))(deps.env.VIVAH_LICENSE_PUBLIC_KEY);
      const { entitlement, status } = verifyEntitlement(stored.entitlementToken, key, deps.now?.() ?? Date.now());
      const until = new Date(entitlement.expiresAt).toISOString().slice(0, 10);
      add({ id: "license", title: "Licence", status: status === "active" ? "ok" : "warn", detail: `${entitlement.plan} plan, ${status}, saved token valid until ${until}`, ...(status !== "active" && { fix: "Connect to the internet and run `vivah license` to renew it." }) });
    } catch (err) {
      add({ id: "license", title: "Licence", status: "fail", detail: `the saved license cannot be verified: ${err instanceof Error ? err.message : String(err)}`, fix: "Run `vivah activate` again." });
    }
  }

  const secrets = await createSecretStore({ platform, dir: path.join(data, "secrets") }).catch(() => undefined);
  add({
    id: "secrets",
    title: "Protected storage",
    status: secrets ? "ok" : "info",
    detail: secrets ? `the sign-in that renews your license is kept in ${{ "windows-dpapi": "Windows protected storage", "macos-keychain": "the macOS keychain", "secret-service": "the desktop keyring", "private-file": "a private file", memory: "memory" }[secrets.backend]}` : "this computer has no protected storage, so the sign-in is kept in a file only your account can read",
  });

  const configured = KEYS.filter(([, variable]) => !!deps.env[variable]).map(([name]) => name);
  add(
    configured.length
      ? { id: "llm", title: "Model access", status: "ok", detail: `keys found for ${configured.join(", ")}` }
      : { id: "llm", title: "Model access", status: "info", detail: "no model API key is set, so only the offline mock and local models work", fix: "Set OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY or AZURE_OPENAI_API_KEY, or run a local model (--provider ollama)." },
  );

  // Editors and tools, each optional: one is enough, and the XMP and built-in renderer need none.
  const rawTherapee = deps.env.RAWTHERAPEE_CLI ?? "rawtherapee-cli";
  const [rt, ff, probe, dt] = await Promise.all([
    version(deps.run, rawTherapee, ["--version"]),
    version(deps.run, deps.env.FFMPEG ?? "ffmpeg", ["-version"]),
    version(deps.run, deps.env.FFPROBE ?? "ffprobe", ["-version"]),
    version(deps.run, deps.env.DARKTABLE_CLI ?? "darktable-cli", ["--version"]),
  ]);
  add(rt ? { id: "rawtherapee", title: "RawTherapee", status: "ok", detail: `found (${rt})` } : { id: "rawtherapee", title: "RawTherapee", status: "info", detail: "not found (optional: edits RAW files and exports JPEGs)", fix: "Install it from https://rawtherapee.com or set RAWTHERAPEE_CLI to rawtherapee-cli." });
  if (!dt) add({ id: "darktable", title: "darktable", status: "info", detail: "not found (optional: edits raw files through darktable's own sidecars)", fix: "Install it from https://www.darktable.org or set DARKTABLE_CLI to darktable-cli." });
  else if (dt !== "found" && !darktableIsSupported(dt)) add({ id: "darktable", title: "darktable", status: "warn", detail: `found (${dt}), but VivahLens writes the settings of darktable ${MIN_VERSION.major}.${MIN_VERSION.minor} or newer`, fix: "Update darktable from https://www.darktable.org/install/, or use another editor." });
  else add({ id: "darktable", title: "darktable", status: "ok", detail: `found (${dt})` });
  add(
    ff && probe
      ? { id: "ffmpeg", title: "ffmpeg", status: "ok", detail: `found (${ff})` }
      : { id: "ffmpeg", title: "ffmpeg", status: "info", detail: "not found (needed only for video: `vivah cut`)", fix: "Install it from https://ffmpeg.org and make sure ffmpeg and ffprobe are on your PATH, or set FFMPEG and FFPROBE." },
  );
  add({ id: "xmp", title: "XMP sidecars and the built-in renderer", status: "ok", detail: "need no other program: --adapter xmp for Lightroom and Camera Raw, --adapter render for finished JPEGs" });

  const app = lightroomApplication(platform, deps.env);
  const modules = lightroomModulesDir(platform, deps.env, home);
  if (app && modules) {
    const installed = await exists(app);
    const plugin = await inspectPlugin(path.join(modules, LIGHTROOM_PLUGIN_FOLDER));
    const shipped = await inspectPlugin(lightroomPluginSource());
    if (!installed && !plugin) add({ id: "lightroom", title: "Lightroom Classic", status: "info", detail: "not found in the usual place (optional: XMP sidecars work with it without the plugin)" });
    else if (!plugin) add({ id: "lightroom", title: "Lightroom Classic", status: "warn", detail: "found, but the VivahLens plugin is not installed (needed only for `--adapter lightroom`)", fix: "Run `vivah plugin lightroom`, then restart Lightroom." });
    else if (plugin.foreign) add({ id: "lightroom", title: "Lightroom Classic", status: "warn", detail: `${path.join(modules, LIGHTROOM_PLUGIN_FOLDER)} holds something that is not the VivahLens plugin`, fix: "Move it aside and run `vivah plugin lightroom`." });
    else if (shipped?.version && plugin.version !== shipped.version) add({ id: "lightroom", title: "Lightroom Classic", status: "warn", detail: `the installed plugin is version ${plugin.version ?? "unknown"}; this release has ${shipped.version}`, fix: "Run `vivah plugin lightroom`, then restart Lightroom." });
    else add({ id: "lightroom", title: "Lightroom Classic", status: "ok", detail: `plugin ${plugin.version ?? ""} installed`.replace("  ", " ") });
    if (await exists(path.join(data, LIGHTROOM_HANDSHAKE_FILE))) add({ id: "handshake", title: "Lightroom connection", status: "info", detail: "a VivahLens run is waiting for the plugin (or ended without cleaning up)" });
  }

  return checks;
}

const MARK: Record<CheckStatus, string> = { ok: "✓", info: "•", warn: "!", fail: "✗" };

/** The checks as lines of text, problems last-but-visible with what to do about them. */
export function formatDoctor(checks: readonly Check[]): string {
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${MARK[c.status]} ${c.title}: ${c.detail}`);
    if (c.fix && c.status !== "ok") lines.push(`    → ${c.fix}`);
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  lines.push("", fails ? `${fails} problem(s) need fixing before VivahLens can run.` : warns ? `Ready, with ${warns} thing(s) worth a look.` : "Everything VivahLens needs is in place.");
  return lines.join("\n");
}
