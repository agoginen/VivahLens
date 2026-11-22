import { describe, expect, it } from "vitest";
import { buildNotifyCommand, cleanNotificationText, notify, scriptedRunner, WINDOWS_TOAST_COMMAND, type Runner } from "../index.js";

const HOSTILE = ["", "-rf", "--version", "a b", '"', "'", "\\", "\\n", "&", "<b>x</b>", "$(calc.exe)", "`whoami`", "%PATH%", "\n", "\u0000", "é日", "IMG_<b>0001</b> & \"x\" 'y' ]]> <script>alert(1)</script>", "😀".repeat(300)];
const FIXED_FLAGS = new Set(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "-EncodedCommand", "-e", "-a", "-u", "--"]);
const decodeWindowsScript = () => Buffer.from(WINDOWS_TOAST_COMMAND, "base64").toString("utf16le");

describe("cleanNotificationText", () => {
  it("removes control characters and line separators, keeps ordinary text", () => {
    expect(cleanNotificationText("a\u0000b\u0007c\u001bd\u007fe\u0085f\u2028g\u2029h", 100, true)).toBe("abcdefgh");
    expect(cleanNotificationText("Anjali & Rohan — 120 photos é日", 100, true)).toBe("Anjali & Rohan — 120 photos é日");
  });

  it("puts a title on one line and keeps the line breaks of a body, normalising CRLF and runs of blank lines", () => {
    expect(cleanNotificationText("a\r\nb\n\nc\td", 100, true)).toBe("a b c d");
    expect(cleanNotificationText("one\r\ntwo\r\n\r\n\r\n\r\nthree\tx", 100, false)).toBe("one\ntwo\n\nthree x");
  });

  it("cuts to the length in whole characters, ending with an ellipsis, never half an emoji", () => {
    const out = cleanNotificationText("😀".repeat(50), 10, false);
    expect(Array.from(out)).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(cleanNotificationText("short", 10, true)).toBe("short");
  });

  it("never leaves a leading dash, which a command-line tool would take for an option", () => {
    for (const text of ["-rf", "--version", "  -x", "\n-y"]) expect(cleanNotificationText(text, 100, false).startsWith("-"), text).toBe(false);
    expect(cleanNotificationText("-rf", 100, true)).toBe(" -rf");
  });
});

describe("buildNotifyCommand", () => {
  it("on Windows runs a fixed PowerShell script and passes the text only as JSON on standard input", () => {
    const c = buildNotifyCommand("win32", { title: 'Job "A" done', body: "12 photos & <more>" })!;
    expect(c.command).toBe("powershell.exe");
    expect(c.args).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", WINDOWS_TOAST_COMMAND]);
    expect(JSON.parse(c.stdin!)).toEqual({ title: 'Job "A" done', body: "12 photos & <more>" });
    expect(c.args.join(" ")).not.toContain("photos");
  });

  it("builds the toast through the DOM with the text as InnerText, never by joining strings, and never evaluates anything", () => {
    const script = decodeWindowsScript();
    expect(script).toContain("CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe')");
    expect(script).toContain("$t.InnerText = [string]$line");
    expect(script).toContain("[Console]::In.ReadToEnd() | ConvertFrom-Json");
    expect(script).not.toMatch(/Invoke-Expression|\biex\b|-Command\b/i);
    expect(script).not.toContain("$in.title +");
  });

  it("on macOS passes the text as arguments to a fixed AppleScript, body first", () => {
    const c = buildNotifyCommand("darwin", { title: "Done", body: 'It said "hi" \\ there' })!;
    expect(c.command).toBe("/usr/bin/osascript");
    expect(c.args.slice(0, 6)).toEqual(["-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)", "-e", "end run"]);
    expect(c.args.slice(6)).toEqual(['It said "hi" \\ there', "Done"]);
    expect(c.stdin).toBeUndefined();
  });

  it("on Linux puts the text after --, escapes backslash then markup in the body (in that order), and leaves the title alone", () => {
    const c = buildNotifyCommand("linux", { title: "A & B <c>", body: "x\\ny & <a href=\"file:///etc\">z</a>" })!;
    expect(c.command).toBe("notify-send");
    expect(c.args.slice(0, 5)).toEqual(["-a", "VivahLens", "-u", "normal", "--"]);
    expect(c.args[5]).toBe("A & B <c>");
    // The backslash is doubled once, and the ampersand that starts "&lt;" is not then doubled again.
    expect(c.args[6]).toBe("x\\\\ny &amp; &lt;a href=\"file:///etc\"&gt;z&lt;/a&gt;");
  });

  it("has nothing to do on a system with no notification route, and falls back to a title when there is none", () => {
    expect(buildNotifyCommand("freebsd", { title: "t", body: "b" })).toBeUndefined();
    expect(JSON.parse(buildNotifyCommand("win32", { title: " \u0000 ", body: "b" })!.stdin!).title).toBe("VivahLens");
  });

  it.each(["win32", "darwin", "linux"] as const)("on %s never lets any text become a shell word or an option, whatever it holds", (platform) => {
    const benign = buildNotifyCommand(platform, { title: "t", body: "b" })!;
    // Text can reach only the last two arguments (the title and the body), and on Windows none: it goes by standard input.
    const fixed = (c: { args: string[] }) => (platform === "win32" ? c.args : c.args.slice(0, -2));
    for (const text of HOSTILE) {
      const c = buildNotifyCommand(platform, { title: text, body: text })!;
      expect(["powershell.exe", "/usr/bin/osascript", "notify-send"]).toContain(c.command);
      expect(c.command, text).toBe(benign.command);
      expect(fixed(c), JSON.stringify(text)).toEqual(fixed(benign));
      for (const arg of c.args) if (arg.startsWith("-")) expect(FIXED_FLAGS.has(arg), `${platform}: ${JSON.stringify(arg)}`).toBe(true);
      if (platform === "win32") expect(JSON.parse(c.stdin!)).toMatchObject({ title: expect.any(String), body: expect.any(String) });
      else expect(c.stdin).toBeUndefined();
    }
  });
});

describe("notify", () => {
  const ok = (calls: { command: string; args: readonly string[]; opts: { stdin?: unknown; timeoutMs?: number } }[]): Runner => async (command, args, opts = {}) => {
    calls.push({ command, args, opts });
    return { code: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false };
  };

  it("runs the command once, with a time limit, and says it was sent", async () => {
    const calls: Parameters<typeof ok>[0] = [];
    expect(await notify({ title: "T", body: "B" }, { platform: "win32", run: ok(calls) })).toEqual({ sent: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("powershell.exe");
    expect(calls[0]!.opts.timeoutMs).toBeGreaterThan(0);
    expect(JSON.parse(String(calls[0]!.opts.stdin))).toEqual({ title: "T", body: "B" });
  });

  it("sends no input on the systems that take the text as arguments", async () => {
    const calls: Parameters<typeof ok>[0] = [];
    await notify({ title: "T", body: "B" }, { platform: "linux", run: ok(calls) });
    expect("stdin" in calls[0]!.opts).toBe(false);
  });

  it("says why nothing was shown, and never throws, whatever goes wrong", async () => {
    const run = (reply: object): Runner => scriptedRunner([{ when: () => true, reply }]).run;
    expect(await notify({ title: "T", body: "B" }, { platform: "linux", run: run({ startError: "spawn notify-send ENOENT", code: null }) })).toEqual({ sent: false, reason: "notify-send could not be started: spawn notify-send ENOENT" });
    expect(await notify({ title: "T", body: "B" }, { platform: "linux", run: run({ code: 1, stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY\n" }) })).toEqual({ sent: false, reason: "notify-send exited with 1: Cannot autolaunch D-Bus without X11 $DISPLAY" });
    expect(await notify({ title: "T", body: "B" }, { platform: "win32", run: run({ timedOut: true, code: null }) })).toEqual({ sent: false, reason: "powershell.exe did not finish in time." });
    const throwing: Runner = async () => {
      throw new Error("boom");
    };
    expect(await notify({ title: "T", body: "B" }, { platform: "darwin", run: throwing })).toEqual({ sent: false, reason: "boom" });
    expect(await notify({ title: "T", body: "B" }, { platform: "aix", run: ok([]) })).toEqual({ sent: false, reason: "Desktop notifications are not available on aix." });
  });
});
