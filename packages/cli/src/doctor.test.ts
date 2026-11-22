import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { signEntitlement, type ProcessRunner } from "@vivahlens/core";
import { installLightroomPlugin, LIGHTROOM_PLUGIN_FOLDER } from "@vivahlens/adapter-lightroom";
import { runCli } from "./commands.js";
import { formatDoctor, runDoctor, type Check, type DoctorDeps } from "./doctor.js";

const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vivah-doctor-"));
  temps.push(dir);
  return dir;
};
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const nothingInstalled: ProcessRunner = async () => ({ code: 1, stdout: "", stderr: "" });
const installed = (found: Record<string, string>): ProcessRunner => async (command) => {
  const hit = Object.entries(found).find(([name]) => command.includes(name));
  return hit ? { code: 0, stdout: hit[1], stderr: "" } : { code: 1, stdout: "", stderr: "" };
};

const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({ env: { VIVAH_HOME: path.join(temp(), "home"), VIVAH_SECRET_STORE: "none" }, run: nothingInstalled, platform: "linux", home: temp(), ...over });
const byId = (checks: Check[], id: string) => checks.find((c) => c.id === id)!;

describe("a machine with nothing set up", () => {
  it("is ready to run but says what is not set up, with what to do about each, and fails nothing", async () => {
    const checks = await runDoctor(deps());
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(byId(checks, "data")).toMatchObject({ status: "ok" });
    expect(byId(checks, "license")).toMatchObject({ status: "warn", fix: expect.stringContaining("vivah activate") });
    expect(byId(checks, "llm")).toMatchObject({ status: "info", fix: expect.stringContaining("OPENAI_API_KEY") });
    expect(byId(checks, "rawtherapee")).toMatchObject({ status: "info", fix: expect.stringContaining("RAWTHERAPEE_CLI") });
    expect(byId(checks, "ffmpeg")).toMatchObject({ status: "info", fix: expect.stringContaining("ffprobe") });
    expect(byId(checks, "xmp").status).toBe("ok");
    expect(formatDoctor(checks)).toMatch(/Ready, with 1 thing\(s\) worth a look\./);
  });

  it("prints a line per check with a mark, and the fix under anything that is not fine", () => {
    const text = formatDoctor([
      { id: "a", title: "Alpha", status: "ok", detail: "fine", fix: "never shown for ok" },
      { id: "b", title: "Beta", status: "warn", detail: "odd", fix: "do this" },
      { id: "c", title: "Gamma", status: "fail", detail: "broken" },
      { id: "d", title: "Delta", status: "info", detail: "note" },
    ]);
    expect(text.split("\n")).toEqual(["✓ Alpha: fine", "! Beta: odd", "    → do this", "✗ Gamma: broken", "• Delta: note", "", "1 problem(s) need fixing before VivahLens can run."]);
    expect(formatDoctor([{ id: "a", title: "A", status: "ok", detail: "x" }])).toMatch(/Everything VivahLens needs is in place\.$/);
  });
});

describe("what it finds", () => {
  it("reports which model keys are set by provider name and never shows a key", async () => {
    const secret = "sk-live-9999999999-DO-NOT-PRINT";
    const checks = await runDoctor(deps({ env: { VIVAH_HOME: path.join(temp(), "h"), VIVAH_SECRET_STORE: "none", OPENAI_API_KEY: secret, ANTHROPIC_API_KEY: secret } }));
    expect(byId(checks, "llm")).toMatchObject({ status: "ok", detail: "keys found for OpenAI, Anthropic" });
    expect(JSON.stringify(checks)).not.toContain(secret);
  });

  it("finds the tools it can use, asking RawTherapee by the path that was configured", async () => {
    const asked: string[] = [];
    const run: ProcessRunner = async (command, args) => {
      asked.push(command);
      return installed({ rawtherapee: "RawTherapee, version 5.12\n", ffmpeg: "ffmpeg version 7.1.1", ffprobe: "ffprobe version 7.1.1", darktable: "this is darktable 5.6.2" })(command, args);
    };
    const checks = await runDoctor(deps({ run, env: { VIVAH_HOME: path.join(temp(), "h"), VIVAH_SECRET_STORE: "none", RAWTHERAPEE_CLI: "C:\\tools\\rawtherapee-cli.exe" } }));
    expect(asked).toContain("C:\\tools\\rawtherapee-cli.exe");
    expect(byId(checks, "rawtherapee")).toMatchObject({ status: "ok", detail: "found (5.12)" });
    expect(byId(checks, "ffmpeg")).toMatchObject({ status: "ok", detail: "found (7.1.1)" });
    expect(byId(checks, "darktable")).toMatchObject({ status: "ok", detail: "found (5.6.2)" });
    // ffmpeg without ffprobe is not enough for video.
    const half = await runDoctor(deps({ run: installed({ "ffmpeg": "ffmpeg version 7.1.1" }) }));
    expect(byId(half, "ffmpeg").status).toBe("info");
  });

  it("asks for darktable by the configured path, and tells an installed darktable that is too old from one that is missing", async () => {
    const asked: string[] = [];
    const run = (answer: string): ProcessRunner => async (command, args) => {
      asked.push(command);
      return installed({ darktable: answer })(command, args);
    };
    const env = { VIVAH_HOME: path.join(temp(), "h"), VIVAH_SECRET_STORE: "none", DARKTABLE_CLI: "D:\\dt\\bin\\darktable-cli.exe" };
    expect(byId(await runDoctor(deps({ run: run("this is darktable 5.8.1"), env })), "darktable")).toMatchObject({ status: "ok", detail: "found (5.8.1)" });
    expect(asked).toContain("D:\\dt\\bin\\darktable-cli.exe");
    expect(byId(await runDoctor(deps({ run: run("this is darktable 5.4.1"), env })), "darktable")).toMatchObject({ status: "warn", detail: "found (5.4.1), but VivahLens writes the settings of darktable 5.6 or newer", fix: expect.stringContaining("darktable.org/install") });
    expect(byId(await runDoctor(deps({ run: run("this is darktable 4.8.0"), env })), "darktable").status).toBe("warn");
    expect(byId(await runDoctor(deps({ run: run("this is darktable 6.0.0"), env })), "darktable").status).toBe("ok");
    expect(byId(await runDoctor(deps({ run: nothingInstalled, env })), "darktable")).toMatchObject({ status: "info", fix: expect.stringContaining("DARKTABLE_CLI") });
  });

  it("fails on a Node that is too old and a data folder that cannot be written", async () => {
    const old = await runDoctor(deps({ nodeVersion: "20.11.0" }));
    expect(byId(old, "node")).toMatchObject({ status: "fail", fix: expect.stringContaining("nodejs.org") });
    expect(byId(await runDoctor(deps({ nodeVersion: "22.13.0" })), "node").status).toBe("ok");
    expect(byId(await runDoctor(deps({ nodeVersion: "22.12.9" })), "node").status).toBe("fail");
    expect(byId(await runDoctor(deps({ nodeVersion: "24.19.0" })), "node").status).toBe("ok");

    const file = path.join(temp(), "a-file");
    writeFileSync(file, "x");
    const blocked = await runDoctor(deps({ env: { VIVAH_HOME: path.join(file, "inside"), VIVAH_SECRET_STORE: "none" } }));
    expect(byId(blocked, "data")).toMatchObject({ status: "fail", fix: expect.stringContaining("VIVAH_HOME") });
  });
});

describe("the licence", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const PUBLIC = publicKey.export({ type: "spki", format: "pem" }) as string;
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 10, 22);
  const activated = (entitlement: { issuedAt: number; expiresAt: number }, key = privateKey) => {
    const home = path.join(temp(), "home");
    mkdirSync(home, { recursive: true });
    const token = signEntitlement({ accountId: "a1", plan: "pro", seats: 1, adapters: ["xmp-sidecar"], ...entitlement }, key);
    writeFileSync(path.join(home, "license.json"), JSON.stringify({ server: "https://license.example", activationId: "act1", entitlementToken: token, refreshToken: "r", refreshTokenIn: "file" }));
    return { VIVAH_HOME: home, VIVAH_SECRET_STORE: "none", VIVAH_LICENSE_PUBLIC_KEY: PUBLIC };
  };

  it("shows the plan and how long the saved token lasts, without contacting the server", async () => {
    const ok = await runDoctor(deps({ env: activated({ issuedAt: NOW - DAY, expiresAt: NOW + 5 * DAY }), now: () => NOW }));
    expect(byId(ok, "license")).toMatchObject({ status: "ok", detail: "pro plan, active, saved token valid until 2026-11-27" });
    const stale = await runDoctor(deps({ env: activated({ issuedAt: NOW - 20 * DAY, expiresAt: NOW - 2 * DAY }), now: () => NOW }));
    expect(byId(stale, "license")).toMatchObject({ status: "warn", fix: expect.stringContaining("vivah license") });
  });

  it("fails on a license that was not signed by the vendor, and explains when it cannot be checked", async () => {
    const forged = activated({ issuedAt: NOW - DAY, expiresAt: NOW + 5 * DAY }, generateKeyPairSync("ed25519").privateKey);
    expect(byId(await runDoctor(deps({ env: forged, now: () => NOW })), "license")).toMatchObject({ status: "fail", fix: expect.stringContaining("vivah activate") });
    const unchecked = { ...activated({ issuedAt: NOW - DAY, expiresAt: NOW + DAY }), VIVAH_LICENSE_PUBLIC_KEY: "" };
    expect(byId(await runDoctor(deps({ env: unchecked })), "license")).toMatchObject({ status: "info", detail: expect.stringContaining("license.example") });
  });
});

describe("Lightroom Classic and its plugin", () => {
  function lightroom() {
    const appData = temp();
    const programs = temp();
    const modules = path.join(appData, "Adobe", "Lightroom", "Modules");
    const exe = path.join(programs, "Adobe", "Adobe Lightroom Classic", "Lightroom.exe");
    return { appData, programs, modules, exe, env: (home: string) => ({ VIVAH_HOME: home, VIVAH_SECRET_STORE: "none", APPDATA: appData, ProgramFiles: programs }) };
  }
  const run = (lr: ReturnType<typeof lightroom>, home = path.join(temp(), "h")) => runDoctor(deps({ platform: "win32", env: lr.env(home), home: temp() }));

  it("says nothing is wrong when Lightroom is not there, and offers the plugin when it is but the plugin is not", async () => {
    const lr = lightroom();
    expect(byId(await run(lr), "lightroom")).toMatchObject({ status: "info" });
    mkdirSync(path.dirname(lr.exe), { recursive: true });
    writeFileSync(lr.exe, "");
    expect(byId(await run(lr), "lightroom")).toMatchObject({ status: "warn", fix: expect.stringContaining("vivah plugin lightroom") });
  });

  it("is happy with the current plugin, flags an old or foreign one, and notices a run waiting for the plugin", async () => {
    const lr = lightroom();
    mkdirSync(path.dirname(lr.exe), { recursive: true });
    writeFileSync(lr.exe, "");
    await installLightroomPlugin({ modulesDir: lr.modules });
    expect(byId(await run(lr), "lightroom")).toMatchObject({ status: "ok", detail: "plugin 1.0.0 installed" });

    const info = path.join(lr.modules, LIGHTROOM_PLUGIN_FOLDER, "Info.lua");
    writeFileSync(info, "return { LrToolkitIdentifier = 'com.vivahlens.lightroom', VERSION = { major = 0, minor = 8, revision = 1 } }");
    expect(byId(await run(lr), "lightroom")).toMatchObject({ status: "warn", detail: expect.stringContaining("version 0.8.1; this release has 1.0.0") });

    writeFileSync(info, "return { LrToolkitIdentifier = 'com.someone.else' }");
    expect(byId(await run(lr), "lightroom")).toMatchObject({ status: "warn", detail: expect.stringContaining("not the VivahLens plugin") });

    const home = path.join(temp(), "waiting");
    mkdirSync(home);
    writeFileSync(path.join(home, "lightroom.json"), "{}");
    expect(byId(await run(lr, home), "handshake")).toMatchObject({ status: "info" });
  });

  it("does not look for Lightroom on a system it does not run on", async () => {
    expect((await runDoctor(deps({ platform: "linux" }))).some((c) => c.id === "lightroom")).toBe(false);
  });
});

describe("vivah doctor", () => {
  it("prints the report, exits 0 when nothing failed, and gives machine-readable output with --json", async () => {
    const lines: string[] = [];
    const env = { VIVAH_HOME: path.join(temp(), "h"), VIVAH_SECRET_STORE: "none", OPENAI_API_KEY: "sk-secret-value" };
    const code = await runCli(["doctor"], { env, run: nothingInstalled, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("✓ Data folder");
    expect(lines.join("\n")).not.toContain("sk-secret-value");

    const json: string[] = [];
    await runCli(["doctor", "--json"], { env, run: nothingInstalled, log: (l) => json.push(l) });
    const parsed = JSON.parse(json.join("\n")) as { checks: Check[] };
    expect(parsed.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["node", "data", "license", "llm", "rawtherapee", "ffmpeg"]));
    expect(json.join("\n")).not.toContain("sk-secret-value");
  });

  it("exits 1 when something has to be fixed", async () => {
    const file = path.join(temp(), "f");
    writeFileSync(file, "x");
    const lines: string[] = [];
    const code = await runCli(["doctor"], { env: { VIVAH_HOME: path.join(file, "no") }, run: nothingInstalled, log: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("✗ Data folder");
  });

  it("installs the Lightroom plugin with `vivah plugin lightroom`, and explains a wrong argument", async () => {
    const lines: string[] = [];
    expect(await runCli(["plugin"], { env: {}, log: (l) => lines.push(l) })).toBe(1);
    expect(lines.join("\n")).toContain("Usage: vivah plugin lightroom");
    if (process.platform !== "win32" && process.platform !== "darwin") {
      const out: string[] = [];
      expect(await runCli(["plugin", "lightroom"], { env: {}, log: (l) => out.push(l) })).toBe(1);
      expect(out.join("\n")).toContain("Windows and macOS only");
      return;
    }
    const appData = temp();
    const out: string[] = [];
    const env = process.platform === "win32" ? { APPDATA: appData } : {};
    if (process.platform === "darwin") return; // the macOS folder is under the real home; not written to by tests
    expect(await runCli(["plugin", "lightroom"], { env, log: (l) => out.push(l) })).toBe(0);
    expect(out.join("\n")).toContain(`Installed the VivahLens plugin 1.0.0 in ${path.join(appData, "Adobe", "Lightroom", "Modules", LIGHTROOM_PLUGIN_FOLDER)}`);
    const again: string[] = [];
    await runCli(["plugin", "lightroom"], { env, log: (l) => again.push(l) });
    expect(again.join("\n")).toContain("Updated the VivahLens plugin");
  });
});
