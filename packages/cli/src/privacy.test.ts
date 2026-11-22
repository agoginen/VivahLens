import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "./commands.js";

function photo(): Buffer {
  const [w, h] = [160, 120];
  const data = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.fill(Math.min(255, 40 + (x / w) * 150 + ((x + y) % 2) * 60), (y * w + x) * 4, (y * w + x) * 4 + 3);
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
}

const root = mkdtempSync(path.join(tmpdir(), "vivah-privacy-"));
const refs = path.join(root, "refs");
const shoot = path.join(root, "shoot");
mkdirSync(refs);
mkdirSync(shoot);
writeFileSync(path.join(refs, "ref.jpg"), photo());
writeFileSync(path.join(shoot, "a.jpg"), photo());
const db = path.join(root, "jobs.db");
const profile = path.join(root, "p.json");

/** A model server on this computer that answers every request with a valid style or recipe, and counts what it was sent. */
let server: http.Server;
let base = "";
const received: { bytes: number }[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      received.push({ bytes: body.length });
      const wantsStyle = body.toString().includes("analyze a photographer");
      const content = wantsStyle ? { summary: "warm", baseAdjustments: { exposure: 0.2 } } : { adjustments: { exposure: 0.2 }, confidence: 0.8 };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 500, completion_tokens: 20 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

function cli(args: string[]) {
  const lines: string[] = [];
  const stdout: string[] = [];
  return runCli(args, { env: { VIVAH_HOME: path.join(root, "home") }, log: (l) => (stdout.push(l), lines.push(l)), info: (l) => void lines.push(l) }).then((code) => ({ code, out: lines.join("\n"), stdout: stdout.join("\n") }));
}

describe("vivah privacy", () => {
  it("says so when nothing has been sent", async () => {
    const r = await cli(["privacy", "--db", db]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Nothing has been sent to any model provider in total.");
  });

  it("records every request to a model with its sizes and purpose, and shows that a model on this computer kept it all", async () => {
    const via = ["--provider", "openai-compatible", "--base-url", base, "--model", "local-vlm", "--db", db];
    expect((await cli(["learn", "--refs", refs, "--name", "Warm", "--out", profile, ...via])).code).toBe(0);
    expect((await cli(["edit", "--folder", shoot, "--profile", profile, "--job", "j1", ...via])).code).toBe(0);
    expect(received.length).toBeGreaterThanOrEqual(2);

    const all = await cli(["privacy", "--db", db]);
    expect(all.out).toContain("Nothing has left this computer in total");
    expect(all.out).toMatch(/openai-compatible \(this computer, nothing left it\): 2 request\(s\), 2 image\(s\), \d+\.\d MB, 1000\/40 tokens in\/out; style-learning ×1, recipe ×1/);

    const job = JSON.parse((await cli(["privacy", "--db", db, "--job", "j1", "--json"])).stdout) as { job: string; totals: { calls: number }; providers: { provider: string; local: boolean; calls: number; images: number; maxEdgePx?: number; purposes: Record<string, number> }[] };
    expect(job.job).toBe("j1");
    expect(job.totals.calls).toBe(0); // nothing left the computer
    expect(job.providers).toEqual([expect.objectContaining({ provider: "openai-compatible", local: true, calls: 1, images: 1, purposes: { recipe: 1 } })]);
    expect(job.providers[0]!.maxEdgePx).toBeLessThanOrEqual(2048);
  });
});
