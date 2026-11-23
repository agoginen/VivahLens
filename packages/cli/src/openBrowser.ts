import { nodeRunner, type Runner } from "@vivahlens/core";

export interface OpenCommand {
  command: string;
  args: string[];
}

export interface OpenOutcome {
  opened: boolean;
  /** Why not, in words for a log line. */
  reason?: string;
}

/** Only the review page's own address (plain http on this computer) is ever handed to the system, so nothing else can be opened through this. */
export const isLocalPageUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
};

/**
 * The program and arguments that open `url` in the default browser on `platform`, or undefined where there is no known way.
 * No shell is involved: the address is one argument, never part of a command line that something could interpret.
 */
export function buildOpenCommand(platform: NodeJS.Platform, url: string): OpenCommand | undefined {
  switch (platform) {
    case "win32":
      return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
    case "darwin":
      return { command: "/usr/bin/open", args: [url] };
    case "linux":
      return { command: "xdg-open", args: [url] };
    default:
      return undefined;
  }
}

/** Opens the review page in the default browser. A convenience: failing only means the person opens the address themselves. */
export async function openInBrowser(url: string, opts: { platform?: NodeJS.Platform; run?: Runner; timeoutMs?: number } = {}): Promise<OpenOutcome> {
  if (!isLocalPageUrl(url)) return { opened: false, reason: "only the local review page can be opened this way" };
  const platform = opts.platform ?? process.platform;
  const command = buildOpenCommand(platform, url);
  if (!command) return { opened: false, reason: `opening a browser is not supported on ${platform}` };
  try {
    const result = await (opts.run ?? nodeRunner)(command.command, command.args, { timeoutMs: opts.timeoutMs ?? 10_000 });
    if (result.startError) return { opened: false, reason: `${command.command} could not be started: ${result.startError}` };
    if (result.timedOut) return { opened: false, reason: `${command.command} did not finish in time` };
    // Windows' handler reports success with 0; a launcher that hands off to an already-running browser may exit non-zero on some systems.
    if (result.code !== 0) return { opened: false, reason: `${command.command} exited with ${result.code}` };
    return { opened: true };
  } catch (err) {
    return { opened: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
