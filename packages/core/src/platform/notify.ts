import { nodeRunner, type Runner } from "./runner.js";

export interface Notification {
  title: string;
  body: string;
}

export interface NotifyCommand {
  command: string;
  args: string[];
  /** Data for the program's standard input; on Windows the only way the text reaches it. */
  stdin?: string;
}

export interface NotifyOutcome {
  sent: boolean;
  /** Why not, in words for a log line. */
  reason?: string;
}

const TITLE_MAX = 100;
const BODY_MAX = 500;
// Control characters other than the line breaks and tab that are handled separately, and the Unicode line and paragraph separators.
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g;

/**
 * Makes text from outside (a folder name, a photo name) fit for a notification: no control characters, a title on one line,
 * a length cap that never cuts a character in half, and never a leading dash, which a command-line tool would take for an option.
 */
export function cleanNotificationText(text: string, max: number, singleLine: boolean): string {
  let out = text.replace(/\r\n?/g, "\n").replace(UNSAFE, "");
  out = singleLine ? out.replace(/\s+/g, " ") : out.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
  out = out.trim();
  const characters = Array.from(out);
  if (characters.length > max) out = `${characters.slice(0, max - 1).join("").trimEnd()}…`;
  return out.startsWith("-") ? ` ${out}` : out;
}

// A fixed script: nothing from outside is ever part of it. The text arrives as JSON on standard input and goes into the toast's
// XML through the DOM, which escapes it. The app identity is PowerShell's own, since there is no installer yet to register ours.
const WINDOWS_SCRIPT = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$toast = $xml.CreateElement('toast'); [void]$xml.AppendChild($toast)
$visual = $xml.CreateElement('visual'); [void]$toast.AppendChild($visual)
$binding = $xml.CreateElement('binding'); $binding.SetAttribute('template','ToastGeneric'); [void]$visual.AppendChild($binding)
foreach ($line in @($in.title, $in.body)) { $t = $xml.CreateElement('text'); $t.InnerText = [string]$line; [void]$binding.AppendChild($t) }
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;

/** The fixed Windows script, encoded the way `powershell -EncodedCommand` wants it (UTF-16LE, base64). */
export const WINDOWS_TOAST_COMMAND = Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64");

/** libnotify turns backslash sequences in a body into characters and reads simple markup in it, so both are neutralised. */
const forLibnotify = (body: string): string => body.replace(/\\/g, "\\\\").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The program, arguments and input that show a desktop notification on `platform`, or undefined where there is no way to.
 * No shell is involved anywhere, and the text is data: JSON on standard input for Windows, arguments to a fixed script for macOS,
 * arguments after `--` for Linux. Only the Windows route has been run (see docs/research/platform-release-security-verification-3.md §7).
 */
export function buildNotifyCommand(platform: NodeJS.Platform, notification: Notification): NotifyCommand | undefined {
  const title = cleanNotificationText(notification.title, TITLE_MAX, true) || "VivahLens";
  const body = cleanNotificationText(notification.body, BODY_MAX, false);
  switch (platform) {
    case "win32":
      return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", WINDOWS_TOAST_COMMAND], stdin: JSON.stringify({ title, body }) };
    case "darwin":
      return { command: "/usr/bin/osascript", args: ["-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)", "-e", "end run", body, title] };
    case "linux":
      return { command: "notify-send", args: ["-a", "VivahLens", "-u", "normal", "--", title, forLibnotify(body)] };
    default:
      return undefined;
  }
}

/**
 * Shows a desktop notification. A convenience and never a way to deliver anything: a computer with no notification service, a
 * focus mode that hides it, or no such tool all give `sent: false` and a reason, and nothing here ever throws.
 */
export async function notify(notification: Notification, opts: { platform?: NodeJS.Platform; run?: Runner; timeoutMs?: number } = {}): Promise<NotifyOutcome> {
  const platform = opts.platform ?? process.platform;
  const command = buildNotifyCommand(platform, notification);
  if (!command) return { sent: false, reason: `Desktop notifications are not available on ${platform}.` };
  try {
    const result = await (opts.run ?? nodeRunner)(command.command, command.args, { ...(command.stdin !== undefined && { stdin: command.stdin }), timeoutMs: opts.timeoutMs ?? 10_000 });
    if (result.startError) return { sent: false, reason: `${command.command} could not be started: ${result.startError}` };
    if (result.timedOut) return { sent: false, reason: `${command.command} did not finish in time.` };
    if (result.code !== 0) return { sent: false, reason: `${command.command} exited with ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 200)}` : ""}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
