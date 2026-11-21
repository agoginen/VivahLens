import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { afterAll, describe, expect, it } from "vitest";
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
  return runCli(args, { env, log: (l) => lines.push(l) }).then((code) => ({ code, out: lines.join("\n") }));
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

  it("explains that the xmp adapter cannot export", async () => {
    const r = await cli(["export", "--folder", shoot, "--approve-all", "--export-dir", path.join(root, "out"), "--db", db, "--job", "j"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("writes edits only");
  });

  it("fails clearly on a missing API key, unknown command and missing approval", async () => {
    expect((await cli(["learn", "--refs", refs, "--name", "x", "--provider", "openai", "--model", "m"])).out).toContain("OPENAI_API_KEY is not set");
    expect((await cli(["bogus"])).code).toBe(1);
    const noApproval = await cli(["export", "--folder", shoot, "--export-dir", root]);
    expect(noApproval.out).toContain("Nothing approved");
  });
});
