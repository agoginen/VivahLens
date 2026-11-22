import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { afterAll, describe, expect, it } from "vitest";
import type { Runner } from "@vivahlens/core";
import { runCli } from "./commands.js";

const root = mkdtempSync(path.join(tmpdir(), "vivah-notify-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function picture(seed: number): Buffer {
  const [w, h] = [160, 107];
  let s = seed * 2654435761 + 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const data = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.fill(Math.max(0, Math.min(255, 128 + 90 * Math.sin((x / w) * (2 + seed) * 6.28) * Math.cos((y / h) * (3 + seed) * 6.28) + (rand() - 0.5) * 60)), (y * w + x) * 4, (y * w + x) * 4 + 3);
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
}

function shoot(name: string): string {
  const folder = path.join(root, name);
  mkdirSync(folder);
  for (let i = 1; i <= 2; i++) writeFileSync(path.join(folder, `IMG_${i}.jpg`), picture(i));
  return folder;
}

const home = path.join(root, "home");
const refs = path.join(root, "refs");
const profile = path.join(root, "style.json");
mkdirSync(refs);
writeFileSync(path.join(refs, "r.jpg"), picture(9));

async function run(args: string[], notifier?: Runner) {
  const lines: string[] = [];
  const code = await runCli(args, { env: { VIVAH_HOME: home }, log: (l) => lines.push(l), info: (l) => lines.push(l), ...(notifier && { notifier }) });
  return { code, out: lines.join("\n") };
}

/** A notifier that records what it was asked to run. */
function recorder(reply: Partial<Awaited<ReturnType<Runner>>> = {}) {
  const calls: { command: string; args: readonly string[]; stdin?: string }[] = [];
  const run: Runner = async (command, args, opts = {}) => {
    calls.push({ command, args, ...(opts.stdin !== undefined && { stdin: String(opts.stdin) }) });
    return { code: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, ...reply };
  };
  return { run, calls };
}

describe("--notify", () => {
  it("learns a style first", async () => {
    expect((await run(["learn", "--refs", refs, "--name", "Notify", "--out", profile, "--provider", "mock"])).code).toBe(0);
  });

  it("shows a notification when an edit finishes, saying how it went", async () => {
    const n = recorder();
    const folder = shoot("wedding-day");
    const r = await run(["edit", "--folder", folder, "--profile", profile, "--provider", "mock", "--db", path.join(root, "a.db"), "--notify"], n.run);
    expect(r.code).toBe(0);
    expect(n.calls).toHaveLength(1);
    const shown = JSON.stringify(n.calls[0]);
    expect(shown).toContain("VivahLens: edit finished");
    expect(shown).toContain("wedding-day: 2 ready for review, 0 culled, 0 failed");
  });

  it("shows nothing unless asked", async () => {
    const n = recorder();
    const r = await run(["edit", "--folder", shoot("quiet"), "--profile", profile, "--provider", "mock", "--db", path.join(root, "b.db")], n.run);
    expect(r.code).toBe(0);
    expect(n.calls).toHaveLength(0);
  });

  it("carries on, with a note, when the notification cannot be shown", async () => {
    const n = recorder({ code: 1, stderr: "no notification service\n" });
    const r = await run(["edit", "--folder", shoot("no-service"), "--profile", profile, "--provider", "mock", "--db", path.join(root, "c.db"), "--notify"], n.run);
    expect(r.code).toBe(0);
    expect(r.out).toContain("2 ready for review");
    expect(r.out).toMatch(/No notification was shown: \S+ exited with 1: no notification service/);
  });

  it("passes a hostile folder name through to the notification as text, never as a command or an option", async () => {
    const n = recorder();
    const folder = shoot("-rf & $(calc) 'x'");
    const r = await run(["edit", "--folder", folder, "--profile", profile, "--provider", "mock", "--db", path.join(root, "d.db"), "--notify"], n.run);
    expect(r.code).toBe(0);
    const call = n.calls[0]!;
    expect(JSON.stringify(call)).toContain("-rf & $(calc) 'x'");
    const fixed = new Set(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "-EncodedCommand", "-e", "-a", "-u", "--"]);
    for (const arg of call.args) if (arg.startsWith("-")) expect(fixed.has(arg), arg).toBe(true);
  });

  it("shows a notification when a delivery finishes", async () => {
    const n = recorder();
    const folder = shoot("exports");
    const r = await run(["deliver", "--folder", folder, "--out", path.join(root, "client"), "--notify"], n.run);
    expect(r.code).toBe(0);
    expect(n.calls).toHaveLength(1);
    expect(JSON.stringify(n.calls[0])).toContain("VivahLens: delivery finished");
    expect(JSON.stringify(n.calls[0])).toContain("2 of 2 file(s) delivered to client");
  });
});
