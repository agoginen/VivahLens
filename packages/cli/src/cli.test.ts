import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runCli } from "./commands.js";

/** Ramp (optionally reversed) with a checkerboard when `sharp`; a smooth ramp reads as blurry. */
function photo(opts: { sharp: boolean; reverse?: boolean }): Buffer {
  const [w, h] = [160, 120];
  const data = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ramp = 40 + ((opts.reverse ? w - 1 - x : x) / w) * 170;
      const v = ramp + (opts.sharp ? ((x + y) % 2) * 60 : 0);
      data.fill(Math.min(255, v), (y * w + x) * 4, (y * w + x) * 4 + 3);
    }
  }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
}

const root = mkdtempSync(path.join(tmpdir(), "vivah-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const refs = path.join(root, "refs");
const shoot = path.join(root, "shoot");
mkdirSync(refs);
mkdirSync(shoot);
writeFileSync(path.join(refs, "ref1.jpg"), photo({ sharp: true }));
writeFileSync(path.join(shoot, "a.jpg"), photo({ sharp: true }));
writeFileSync(path.join(shoot, "b.jpg"), photo({ sharp: true, reverse: true }));
writeFileSync(path.join(shoot, "soft.jpg"), photo({ sharp: false }));

const db = path.join(root, "jobs.db");
const profile = path.join(root, "warm.profile.json");

function cli(args: string[], env: Record<string, string> = {}) {
  const lines: string[] = [];
  const stdout: string[] = [];
  return runCli(args, {
    env,
    log: (l) => (stdout.push(l), lines.push(l)),
    info: (l) => void lines.push(l),
  }).then((code) => ({ code, out: lines.join("\n"), stdout: stdout.join("\n") }));
}

describe("vivah CLI (mock provider)", () => {
  it("learns a style, edits a folder to XMP sidecars, culls the blurry frame, and resumes without redoing work", async () => {
    const learned = await cli(["learn", "--refs", refs, "--name", "Warm", "--out", profile, "--provider", "mock"]);
    expect(learned.code).toBe(0);
    expect(JSON.parse(readFileSync(profile, "utf8"))).toMatchObject({ id: "warm", version: 1 });

    const edited = await cli(["edit", "--folder", shoot, "--profile", profile, "--provider", "mock", "--db", db, "--job", "j"]);
    expect(edited.code).toBe(0);
    expect(edited.out).toContain("2 ready for review, 1 culled, 0 failed");
    expect(readFileSync(path.join(shoot, "a.xmp"), "utf8")).toContain('crs:Exposure2012="+0.30"');
    expect(existsSync(path.join(shoot, "b.xmp"))).toBe(true);
    expect(existsSync(path.join(shoot, "soft.xmp"))).toBe(false);

    const again = await cli(["edit", "--folder", shoot, "--profile", profile, "--provider", "mock", "--db", db, "--job", "j"]);
    expect(again.out).toContain("LLM calls: 0");
  });

  it("learns a style from the photographer's own XMP edits without any LLM", async () => {
    const edits = path.join(root, "my-edits");
    mkdirSync(edits);
    for (const [name, exposure] of [["1", "+0.20"], ["2", "+0.40"], ["3", "+0.60"]] as const) {
      writeFileSync(path.join(edits, `${name}.xmp`), `<x:xmpmeta><rdf:Description crs:HasSettings="True" crs:Exposure2012="${exposure}" crs:Contrast2012="+15"/></x:xmpmeta>`);
    }
    const out = path.join(root, "mine.profile.json");
    const r = await cli(["learn", "--from-xmp", edits, "--name", "Mine", "--out", out]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("learned from 3 XMP edit(s)");
    expect(JSON.parse(readFileSync(out, "utf8")).baseAdjustments).toEqual({ exposure: 0.4, contrast: 15 });
  });

  it("approves on an edit-only adapter and tells the user to export from their editor", async () => {
    const r = await cli(["export", "--folder", shoot, "--approve", "a.jpg", "--db", db, "--job", "j"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Approved 1 photo(s)");
    expect(r.out).toContain("writes edits only");
  });

  it("reports the acceptance rate and corrections for a job", async () => {
    const r = await cli(["stats", "--folder", shoot, "--db", db, "--job", "j"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("3 photos");
    expect(r.out).toContain("approved: 1 (1 unchanged, 0 corrected)");
    expect(r.out).toContain("acceptance rate: 100%");
    expect(r.out).toContain("1 blurry");
    const json = JSON.parse((await cli(["stats", "--job", "j", "--db", db, "--json"])).stdout);
    expect(json).toMatchObject({ approved: 1, awaitingReview: 1, acceptanceRate: 1 });
    expect((await cli(["stats", "--job", "nope", "--db", db])).out).toContain('No job "nope"');
  });

  it("scores LLM edits against the photographer's own XMP edits", async () => {
    const gold = path.join(root, "gold");
    mkdirSync(gold);
    // The mock model proposes exposure +0.3, contrast +12, shadows +15, 5400K.
    const edits: Record<string, string> = {
      "g1": 'crs:Exposure2012="+0.40" crs:Contrast2012="+10" crs:Shadows2012="+20" crs:WhiteBalance="Custom" crs:Temperature="5300"',
      "g2": 'crs:Exposure2012="+0.20" crs:Contrast2012="+14" crs:Shadows2012="+10" crs:WhiteBalance="Custom" crs:Temperature="5500"',
      "g3": 'crs:Exposure2012="-2.00" crs:Contrast2012="+10"',
    };
    for (const [name, attrs] of Object.entries(edits)) {
      writeFileSync(path.join(gold, `${name}.jpg`), photo({ sharp: true }));
      writeFileSync(path.join(gold, `${name}.xmp`), `<x:xmpmeta><rdf:Description crs:HasSettings="True" ${attrs}/></x:xmpmeta>`);
    }
    writeFileSync(path.join(gold, "no-truth.jpg"), photo({ sharp: true }));

    const r = await cli(["eval", "--folder", gold, "--profile", profile, "--provider", "mock"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Scoring 3 photo(s)");
    expect(r.out).toContain("Acceptance: 67% (2/3)");
    expect(r.out).toContain("schema-valid: 100%");
    expect(r.out).toMatch(/exposure\s+within tolerance 2\/3/);

    const limited = await cli(["eval", "--folder", gold, "--profile", profile, "--provider", "mock", "--limit", "1", "--json"]);
    expect(JSON.parse(limited.stdout)).toMatchObject({ total: 1, accepted: 1, acceptanceRate: 1 });
    expect((await cli(["eval", "--folder", shoot, "--profile", profile, "--provider", "mock"])).out).toContain("written by VivahLens, not by you");
    expect((await cli(["eval", "--folder", shoot, "--profile", profile, "--provider", "mock"])).out).toContain("No photos with a sibling .xmp edit made by you");
  });

  it("stops cleanly when cancelled and tells the user how to resume", async () => {
    const abort = new AbortController();
    abort.abort();
    const lines: string[] = [];
    const code = await runCli(["edit", "--folder", shoot, "--profile", profile, "--provider", "mock", "--db", path.join(root, "cancel.db"), "--job", "c"], {
      env: {},
      log: (l) => lines.push(l),
      signal: abort.signal,
    });
    expect(code).toBe(130);
    expect(lines.join("\n")).toContain("run the same command again to resume");
  });

  it("enforces the license when a public key is configured", async () => {
    const r = await cli(["edit", "--folder", shoot, "--profile", profile, "--provider", "mock", "--db", path.join(root, "lic.db")], { VIVAH_LICENSE_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\nbogus\n-----END PUBLIC KEY-----" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("ENTITLEMENT_INVALID");
  });

  it("serves the review UI on loopback and stops on abort", async () => {
    const abort = new AbortController();
    const lines: string[] = [];
    const running = runCli(["review", "--folder", shoot, "--profile", profile, "--db", db, "--job", "j"], {
      env: {},
      log: (l) => lines.push(l),
      signal: abort.signal,
    });
    const url = await vi.waitFor(() => {
      const found = lines.join("\n").match(/http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/)?.[0];
      if (!found) throw new Error("server not up yet");
      return found;
    });
    const origin = new URL(url).origin;
    const token = new URL(url).searchParams.get("t")!;
    const data = (await (await fetch(`${origin}/api/items?t=${token}`)).json()) as { items: { id: string; state: string }[] };
    expect(data.items.map((i) => [i.id, i.state])).toEqual(expect.arrayContaining([["a.jpg", "approved"], ["b.jpg", "review"]]));
    abort.abort();
    expect(await running).toBe(0);
  });

  it("shows a cost estimate from a price table and refuses to start above --max-cost", async () => {
    const prices = path.join(root, "prices.json");
    writeFileSync(prices, JSON.stringify({ effectiveFrom: "2026-01-01", models: { cheap: { inputPerMTok: 1, outputPerMTok: 4 } } }));
    const over = await cli(["edit", "--folder", shoot, "--profile", profile, "--provider", "openai", "--model", "cheap", "--prices", prices, "--max-cost", "0.000001", "--db", db], { OPENAI_API_KEY: "k" });
    expect(over.out).toContain("Estimated LLM cost: ≈ $0.01");
    expect(over.out).toContain("[BUDGET_EXCEEDED]");
    expect(over.out).toContain("nothing was sent");
  });

  it("fails clearly on a missing API key, unknown command and missing approval", async () => {
    expect((await cli(["learn", "--refs", refs, "--name", "x", "--provider", "openai", "--model", "m"])).out).toContain("OPENAI_API_KEY is not set");
    expect((await cli(["bogus"])).code).toBe(1);
    const noApproval = await cli(["export", "--folder", shoot, "--export-dir", root]);
    expect(noApproval.out).toContain("Nothing approved");
  });
});
