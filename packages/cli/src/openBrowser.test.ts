import { scriptedRunner } from "@vivahlens/core";
import { describe, expect, it } from "vitest";
import { buildOpenCommand, isLocalPageUrl, openInBrowser } from "./openBrowser.js";

const URL_OK = "http://127.0.0.1:4321/?t=abc_DEF-123";

describe("opening the review page", () => {
  it("hands the address to the system's own opener as a single argument, with no shell", () => {
    expect(buildOpenCommand("win32", URL_OK)).toEqual({ command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", URL_OK] });
    expect(buildOpenCommand("darwin", URL_OK)).toEqual({ command: "/usr/bin/open", args: [URL_OK] });
    expect(buildOpenCommand("linux", URL_OK)).toEqual({ command: "xdg-open", args: [URL_OK] });
    expect(buildOpenCommand("freebsd", URL_OK)).toBeUndefined();
  });

  it("opens only the local review page", () => {
    expect(isLocalPageUrl(URL_OK)).toBe(true);
    for (const bad of ["https://127.0.0.1:1/", "http://example.com/", "http://127.0.0.1.evil.example/", "file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "calc.exe", "", "http://localhost:1/"]) {
      expect(isLocalPageUrl(bad), bad).toBe(false);
    }
  });

  it("refuses anything else without starting a program", async () => {
    const { run, calls } = scriptedRunner([]);
    expect(await openInBrowser("http://example.com/", { platform: "win32", run })).toEqual({ opened: false, reason: "only the local review page can be opened this way" });
    expect(calls).toEqual([]);
  });

  it("reports opened when the system's opener succeeds, and says why when it does not", async () => {
    const ok = scriptedRunner([{ when: () => true, reply: { code: 0 } }]);
    expect(await openInBrowser(URL_OK, { platform: "linux", run: ok.run })).toEqual({ opened: true });
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0]).toMatchObject({ command: "xdg-open", args: [URL_OK] });

    const missing = scriptedRunner([{ when: () => true, reply: { code: null, startError: "spawn xdg-open ENOENT" } }]);
    expect((await openInBrowser(URL_OK, { platform: "linux", run: missing.run })).reason).toContain("could not be started");

    const failed = scriptedRunner([{ when: () => true, reply: { code: 3 } }]);
    expect((await openInBrowser(URL_OK, { platform: "darwin", run: failed.run })).reason).toContain("exited with 3");

    const slow = scriptedRunner([{ when: () => true, reply: { code: null, timedOut: true } }]);
    expect((await openInBrowser(URL_OK, { platform: "win32", run: slow.run })).reason).toContain("did not finish");

    expect((await openInBrowser(URL_OK, { platform: "freebsd" })).reason).toContain("not supported on freebsd");
  });

  it("never throws, even when the runner does", async () => {
    const run = async () => {
      throw new Error("boom");
    };
    expect(await openInBrowser(URL_OK, { platform: "win32", run })).toEqual({ opened: false, reason: "boom" });
  });
});
