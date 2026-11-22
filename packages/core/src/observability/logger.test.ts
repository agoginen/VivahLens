import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isCurrentUserOnly } from "../platform/privateFile.js";
import { createLogger, memoryLogger, nullLogger } from "./logger.js";
import { openLogFile, readRecentLogs } from "./logFile.js";

const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vivah-log-"));
  roots.push(dir);
  return dir;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const T0 = new Date(Date.UTC(2026, 10, 22, 12, 0, 0));

describe("the logger", () => {
  it("writes one JSON record per event with time, level and event first, then the base fields, then the call's", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), now: () => T0, base: { app: "vivah", jobId: "j1" } });
    log.info("item.applied", { assetId: "a.cr3", durationMs: 41 });
    expect(lines).toEqual(['{"ts":"2026-11-22T12:00:00.000Z","level":"info","event":"item.applied","app":"vivah","jobId":"j1","assetId":"a.cr3","durationMs":41}']);
  });

  it("drops what is below the level, and lets a child add fields without changing its parent", () => {
    const logger = memoryLogger({ level: "warn" });
    logger.info("hidden");
    logger.debug("hidden");
    const job = logger.child({ jobId: "j" });
    job.warn("careful", { a: 1 });
    logger.error("bad");
    expect(logger.records.map((r) => [r.level, r.event, r.jobId, r.a])).toEqual([["warn", "careful", "j", 1], ["error", "bad", undefined, undefined]]);
  });

  it("does not let a field overwrite the time, level or event", () => {
    const logger = memoryLogger({ now: () => T0 });
    logger.info("real", { ts: "1999", level: "error", event: "fake" });
    expect(logger.records[0]).toMatchObject({ ts: "2026-11-22T12:00:00.000Z", level: "info", event: "real" });
  });

  it("redacts every field: keys, tokens, image data, error text and the home folder never reach the output", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), redact: { home: "C:\\Users\\Jane" } });
    log.error("llm.call", {
      apiKey: "sk-live-abcdefghijklmnop",
      provider: "openai",
      inputTokens: 1200,
      preview: { dataBase64: "A".repeat(10000) },
      error: new Error("401 from https://api.example/v1?key=abcd1234 for C:\\Users\\Jane\\wedding\\a.cr3, send to jane@x.example"),
    });
    const text = lines.join("\n");
    expect(text).not.toMatch(/sk-live|AAAAAAAA|abcd1234|jane@|Jane/);
    expect(JSON.parse(text)).toMatchObject({ apiKey: "[redacted]", provider: "openai", inputTokens: 1200, preview: { dataBase64: "[omitted image data]" } });
    expect(text).toContain("~\\\\wedding\\\\a.cr3");
  });

  it("never throws, whatever it is given or however the sink fails", () => {
    const loud = createLogger({
      write: () => {
        throw new Error("disk full");
      },
    });
    expect(() => loud.info("x", { n: 1n, f: () => 1 })).not.toThrow();
    const hostile = { get boom(): never { throw new Error("getter"); } };
    expect(() => createLogger({ write: () => undefined }).info("x", hostile)).not.toThrow();
    expect(() => nullLogger.child({ a: 1 }).error("x")).not.toThrow();
  });
});

describe("the log file", () => {
  it("keeps records in order, one per line, in a folder only this user can open", async () => {
    const dir = path.join(temp(), "logs");
    const out = await openLogFile({ dir });
    const log = createLogger({ write: out.write, now: () => T0 });
    for (let i = 0; i < 5; i++) log.info("tick", { i });
    await out.flush();
    expect(readFileSync(out.file, "utf8").trim().split("\n").map((l) => JSON.parse(l).i)).toEqual([0, 1, 2, 3, 4]);
    if (process.platform === "win32") expect(await isCurrentUserOnly(dir)).toBe(true);
    else expect(statSync(dir).mode & 0o077).toBe(0);
  });

  it("starts a new file when the current one is full and forgets the oldest beyond the number kept", async () => {
    const dir = path.join(temp(), "logs");
    const out = await openLogFile({ dir, maxBytes: 200, keep: 2 });
    for (let i = 0; i < 40; i++) out.write(JSON.stringify({ i, pad: "x".repeat(20) }));
    await out.flush();
    expect(readdirSync(dir).sort()).toEqual(["vivah.1.jsonl", "vivah.2.jsonl", "vivah.jsonl"]);
    for (const f of readdirSync(dir)) expect(statSync(path.join(dir, f)).size).toBeLessThanOrEqual(200);
    // The newest 40 are spread over the files that remain, newest in the current one, none out of order or twice.
    const all = [2, 1, 0].flatMap((n) => readFileSync(path.join(dir, n === 0 ? "vivah.jsonl" : `vivah.${n}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l).i as number));
    expect(all[all.length - 1]).toBe(39);
    expect(all).toEqual([...all].sort((a, b) => a - b));
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps nothing but the current file when told to keep none", async () => {
    const dir = path.join(temp(), "logs");
    const out = await openLogFile({ dir, maxBytes: 100, keep: 0 });
    for (let i = 0; i < 20; i++) out.write(JSON.stringify({ i, pad: "y".repeat(20) }));
    await out.flush();
    expect(readdirSync(dir)).toEqual(["vivah.jsonl"]);
    expect(statSync(out.file).size).toBeLessThanOrEqual(100);
  });

  it("carries on appending to an existing file after a restart, counting what is already there", async () => {
    const dir = path.join(temp(), "logs");
    const first = await openLogFile({ dir, maxBytes: 300, keep: 1 });
    first.write(JSON.stringify({ n: 1, pad: "z".repeat(150) }));
    await first.flush();
    const second = await openLogFile({ dir, maxBytes: 300, keep: 1 });
    second.write(JSON.stringify({ n: 2, pad: "z".repeat(150) }));
    await second.flush();
    expect(readdirSync(dir).sort()).toEqual(["vivah.1.jsonl", "vivah.jsonl"]);
    expect(JSON.parse(readFileSync(path.join(dir, "vivah.1.jsonl"), "utf8")).n).toBe(1);
    expect(JSON.parse(readFileSync(path.join(dir, "vivah.jsonl"), "utf8")).n).toBe(2);
  });

  it("counts a write that fails instead of throwing", async () => {
    const dir = path.join(temp(), "logs");
    const out = await openLogFile({ dir });
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "now a file"); // the folder is gone and something else is in its place
    out.write("{}");
    await out.flush();
    expect(out.failedWrites).toBe(1);
  });

  it("reads back the newest records across files, oldest first, skipping a half-written line", async () => {
    const dir = path.join(temp(), "logs");
    const out = await openLogFile({ dir, maxBytes: 150, keep: 3 });
    for (let i = 0; i < 12; i++) out.write(JSON.stringify({ ts: "t", level: "info", event: "e", i, pad: "q".repeat(10) }));
    await out.flush();
    writeFileSync(out.file, `${readFileSync(out.file, "utf8")}{"ts":"t","lev`);
    const records = await readRecentLogs(dir, { maxRecords: 5 });
    expect(records.map((r) => r.i)).toEqual([7, 8, 9, 10, 11]);
    expect(await readRecentLogs(temp())).toEqual([]);
  });
});
