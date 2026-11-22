import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { afterAll, describe, expect, it } from "vitest";
import { createLogger, MemoryStore, openLogFile, type ProcessRunner } from "@vivahlens/core";
import { runCli } from "./commands.js";
import { BUNDLE_FORMAT, buildDiagnostics, type SystemInfo } from "./diagnostics.js";
import { logsDir } from "./logging.js";

const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vivah-diag-"));
  roots.push(dir);
  return dir;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const nothing: ProcessRunner = async () => ({ code: 1, stdout: "", stderr: "" });
const SYSTEM: SystemInfo = { platform: "win32", release: "10.0.22631", arch: "x64", node: "24.1.0", cpus: 8, memoryGb: 16, locale: "en-IN" };
const HOME = "C:\\Users\\Priya Sharma";
const KEY = "sk-live-9f8e7d6c5b4a39281716";

async function populated() {
  const vivahHome = path.join(temp(), "home");
  const store = new MemoryStore();
  const folder = "D:\\Weddings\\Sharma Wedding 2026\\RAW";
  store.ensureJob({ id: "Sharma Wedding 2026", name: "RAW", adapterId: "lightroom-classic", styleProfileId: "priya-warm", createdAt: "2026-11-20T10:00:00Z" });
  store.putItem({ jobId: "Sharma Wedding 2026", assetId: "IMG_0412.CR3", state: "review", attempts: 0 });
  store.putItem({ jobId: "Sharma Wedding 2026", assetId: "IMG_0413.CR3", state: "review", attempts: 0 });
  store.putItem({
    jobId: "Sharma Wedding 2026",
    assetId: "IMG_0414.CR3",
    state: "failed",
    failedFrom: "review",
    attempts: 2,
    errorCode: "ADAPTER_APPLY_FAILED",
    errorMessage: `Lightroom refused ${folder}\\IMG_0414.CR3 for priya.sharma@studio.example using ${KEY}`,
  });
  store.appendAudit({ at: "2026-11-20T10:00:01Z", action: "job-started", jobId: "Sharma Wedding 2026", meta: { photos: 3, adapter: "lightroom-classic", profile: "priya-warm@2" } });
  store.recordOutbound({ at: "2026-11-20T10:00:02Z", jobId: "Sharma Wedding 2026", provider: "openai", model: "gpt-x", purpose: "recipe", images: 3, imageBytes: 300000, maxEdgePx: 2048 });

  const file = await openLogFile({ dir: logsDir({ VIVAH_HOME: vivahHome }) });
  const log = createLogger({ write: file.write, redact: { home: HOME }, base: { command: "edit" } });
  log.info("item.done", { jobId: "Sharma Wedding 2026", assetId: "IMG_0412.CR3", stage: "review", durationMs: 40, adapter: "lightroom-classic" });
  log.warn("item.failed", { jobId: "Sharma Wedding 2026", assetId: "IMG_0414.CR3", stage: "review", code: "ADAPTER_APPLY_FAILED", message: `Lightroom refused ${folder}\\IMG_0414.CR3 using ${KEY}`, apiKey: KEY });
  await file.flush();
  return { vivahHome, store, folder };
}

describe("the support bundle", () => {
  it("describes the job, the checks, the system and the recent log, in a stable format", async () => {
    const { vivahHome, store } = await populated();
    const bundle = await buildDiagnostics({ env: { VIVAH_HOME: vivahHome }, run: nothing, store, jobId: "Sharma Wedding 2026", home: HOME, system: SYSTEM, now: () => new Date(Date.UTC(2026, 10, 22, 9)), salt: "s" });

    expect(bundle).toMatchObject({ format: BUNDLE_FORMAT, createdAt: "2026-11-22T09:00:00.000Z", system: SYSTEM });
    expect(bundle.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["node", "data", "license", "llm"]));
    expect(bundle.job).toMatchObject({
      adapter: "lightroom-classic",
      photos: 3,
      states: { review: 2, failed: 1 },
      errors: [{ code: "ADAPTER_APPLY_FAILED", count: 1, stages: ["review"] }],
      outbound: { totals: { calls: 1, images: 3 } },
      undo: { recorded: 0, notUndoneYet: 0 },
    });
    expect(bundle.job!.audit[0]).toMatchObject({ action: "job-started", meta: { photos: 3, adapter: "lightroom-classic" } });
    expect(bundle.logs.map((r) => r.event)).toEqual(["item.done", "item.failed"]);
    expect(bundle.logs[1]).toMatchObject({ code: "ADAPTER_APPLY_FAILED", apiKey: "[redacted]" });
    expect(bundle.notes.join(" ")).toContain("Nothing has been sent anywhere");
  });

  it("holds nothing personal: no photo, job, style or folder names, no account name, address or key", async () => {
    const { vivahHome, store, folder } = await populated();
    const bundle = await buildDiagnostics({ env: { VIVAH_HOME: vivahHome }, run: nothing, store, jobId: "Sharma Wedding 2026", folder, home: HOME, system: SYSTEM, salt: "s" });
    const text = JSON.stringify(bundle);
    for (const secret of ["IMG_0412", "IMG_0413", "IMG_0414", "Sharma", "priya", "Priya", "Weddings", KEY, "studio.example", "9f8e7d6c", "D:\\\\", vivahHome]) {
      expect(text, secret).not.toContain(secret);
    }
    // The failure is still understandable: what kind of file, in what stage, with what code.
    expect(bundle.job!.errors[0]!.example).toMatch(/^Lightroom refused <dir>\/photo-[0-9a-f]{8}\.CR3 for \[email\] using \[redacted\]$/);
  });

  it("uses the same stand-in for the same name everywhere, and different ones for different names", async () => {
    const { vivahHome, store } = await populated();
    const bundle = await buildDiagnostics({ env: { VIVAH_HOME: vivahHome }, run: nothing, store, jobId: "Sharma Wedding 2026", home: HOME, system: SYSTEM, salt: "s" });
    // Our own wording is left as it is, even when a job happens to be named after a word in it.
    expect(bundle.checks.find((c) => c.id === "rawtherapee")!.detail).toBe("not found (optional: edits RAW files and exports JPEGs)");
    expect(bundle.job!.id).toMatch(/^job-[0-9a-f]{8}$/);
    const fromJob = /photo-[0-9a-f]{8}/.exec(bundle.job!.errors[0]!.example)![0];
    const fromLog = /photo-[0-9a-f]{8}/.exec(String(bundle.logs[1]!.message))![0];
    expect(fromJob).toBe(fromLog);
    expect(bundle.logs[1]!.assetId).toBe(`${fromLog}.CR3`);
    expect(bundle.logs[0]!.assetId).not.toBe(`${fromLog}.CR3`);
    expect(bundle.job!.id).toMatch(/^job-[0-9a-f]{8}$/);
    expect(bundle.job!.style).toMatch(/^style-[0-9a-f]{8}$/);
    expect(bundle.job!.audit[0]!.meta!.profile).toMatch(/^style-[0-9a-f]{8}@2$/);

    // A different bundle uses different stand-ins, so two of them cannot be matched up by name.
    const other = await buildDiagnostics({ env: { VIVAH_HOME: vivahHome }, run: nothing, store, jobId: "Sharma Wedding 2026", home: HOME, system: SYSTEM, salt: "other" });
    expect(other.job!.id).not.toBe(bundle.job!.id);
  });

  it("does not replace a short name inside other words", async () => {
    const { vivahHome } = await populated();
    const store = new MemoryStore();
    store.ensureJob({ id: "a", name: "a", adapterId: "xmp-sidecar", styleProfileId: "warm", createdAt: "" });
    store.putItem({ jobId: "a", assetId: "e", state: "failed", failedFrom: "review", attempts: 1, errorCode: "ASSET_UNREADABLE", errorMessage: "the file e was not readable, a failure" });
    const bundle = await buildDiagnostics({ env: { VIVAH_HOME: vivahHome }, run: nothing, store, jobId: "a", home: HOME, system: SYSTEM, salt: "s" });
    expect(bundle.job!.errors[0]!.example).toMatch(/^the file photo-[0-9a-f]{8} was not readable, job-[0-9a-f]{8} failure$/);
  });

  it("has no job section without a job, keeps only the newest log records, and copes with there being no log", async () => {
    const vivahHome = path.join(temp(), "home");
    const none = await buildDiagnostics({ env: { VIVAH_HOME: vivahHome }, run: nothing, home: HOME, system: SYSTEM });
    expect(none.job).toBeUndefined();
    expect(none.logs).toEqual([]);

    const file = await openLogFile({ dir: logsDir({ VIVAH_HOME: vivahHome }) });
    const log = createLogger({ write: file.write });
    for (let i = 0; i < 40; i++) log.info("tick", { i });
    await file.flush();
    const some = await buildDiagnostics({ env: { VIVAH_HOME: vivahHome }, run: nothing, home: HOME, system: SYSTEM, maxLogRecords: 10 });
    expect(some.logs.map((r) => r.i)).toEqual([30, 31, 32, 33, 34, 35, 36, 37, 38, 39]);
  });
});

describe("vivah diagnostics", () => {
  const photo = (variant = 0) => {
    const [w, h] = [96, 64];
    const data = Buffer.alloc(w * h * 4, 255);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.fill(Math.min(255, 50 + (variant ? w - 1 - x : x) * 2 + ((x + y) % 2) * 60), (y * w + x) * 4, (y * w + x) * 4 + 3);
    return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
  };

  it("writes a bundle after a real edit, with the run's own log in it and none of the photographer's names", async () => {
    const root = temp();
    const folder = path.join(root, "Sharma Wedding 2026");
    mkdirSync(folder);
    writeFileSync(path.join(folder, "IMG_0412.jpg"), photo(0));
    writeFileSync(path.join(folder, "IMG_0413.jpg"), photo(1));
    writeFileSync(path.join(root, "ref.jpg"), photo(0));
    const env = { VIVAH_HOME: path.join(root, "home") };
    const quiet = { env, log: () => undefined, info: () => undefined };
    const profile = path.join(root, "PriyaLook.profile.json");
    expect(await runCli(["learn", "--refs", root, "--name", "PriyaLook", "--out", profile, "--provider", "mock"], quiet)).toBe(0);
    const db = path.join(root, "jobs.db");
    expect(await runCli(["edit", "--folder", folder, "--profile", profile, "--provider", "mock", "--db", db], quiet)).toBe(0);

    const lines: string[] = [];
    const out = path.join(root, "support.json");
    expect(await runCli(["diagnostics", "--folder", folder, "--db", db, "--out", out], { env, log: (l) => lines.push(l), info: () => undefined })).toBe(0);
    expect(lines[0]).toMatch(/^Wrote .*support\.json \(\d+ KB\)\.$/);
    expect(lines.join("\n")).toContain("Nothing has been sent anywhere");

    const text = readFileSync(out, "utf8");
    const bundle = JSON.parse(text);
    expect(bundle.job).toMatchObject({ adapter: "xmp-sidecar", photos: 2, states: { review: 2 } });
    const events = bundle.logs.map((r: { event: string }) => r.event);
    expect(events).toEqual(expect.arrayContaining(["command-started", "job-started", "item.done", "job-ready-for-review"]));
    expect(bundle.logs.find((r: { event: string; stage?: string }) => r.event === "item.done" && r.stage === "review")).toMatchObject({ adapter: "xmp-sidecar" });
    for (const name of ["Sharma", "IMG_0412", "IMG_0413", "PriyaLook", "priyalook", os.userInfo().username]) expect(text, name).not.toContain(name);
    expect(text).not.toContain(root);
  });

  it("explains a missing database or job, and writes nothing", async () => {
    const root = temp();
    const out = path.join(root, "x.json");
    const lines: string[] = [];
    const run = (args: string[]) => runCli(args, { env: { VIVAH_HOME: path.join(root, "home") }, log: (l) => lines.push(l), info: () => undefined });
    expect(await run(["diagnostics", "--job", "nope", "--out", out])).toBe(1);
    expect(lines.join("\n")).toContain("No job database at");
    expect(existsSync(out)).toBe(false);
  });

  it("works without any job: versions, checks and the log", async () => {
    const root = temp();
    const out = path.join(root, "plain.json");
    expect(await runCli(["diagnostics", "--out", out], { env: { VIVAH_HOME: path.join(root, "home") }, log: () => undefined, info: () => undefined, run: nothing })).toBe(0);
    const bundle = JSON.parse(readFileSync(out, "utf8"));
    expect(bundle).toMatchObject({ format: BUNDLE_FORMAT });
    expect(bundle.job).toBeUndefined();
    expect(bundle.checks.length).toBeGreaterThan(5);
  });
});
