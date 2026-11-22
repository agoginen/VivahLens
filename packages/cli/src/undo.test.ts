import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "./commands.js";

/** `kind` picks the gradient direction (so culling never sees two shots as near-duplicates); `level` shifts brightness so every file's bytes are unique. */
function photo(kind: 0 | 1 | 2 | 3, level: number): Buffer {
  const [w, h] = [160, 120];
  const data = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = [x / w, 1 - x / w, y / h, 1 - y / h][kind]!;
      const v = Math.min(255, 40 + t * 150 + level * 12 + ((x + y) % 2) * 60);
      data.fill(v, (y * w + x) * 4, (y * w + x) * 4 + 3);
    }
  }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
}

const root = mkdtempSync(path.join(tmpdir(), "vivah-undo-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const db = path.join(root, "jobs.db");
const profile = path.join(root, "warm.profile.json");

function cli(args: string[], env: Record<string, string> = {}) {
  const lines: string[] = [];
  return runCli(args, { env: { VIVAH_HOME: path.join(root, "home"), ...env }, log: (l) => void lines.push(l), info: (l) => void lines.push(l) }).then((code) => ({ code, out: lines.join("\n") }));
}

const own = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="5" xmp:Label="Keeper"/></rdf:RDF></x:xmpmeta>`;

function shootWith(name: string, files: Record<string, [0 | 1 | 2 | 3, number]>): string {
  const dir = path.join(root, name);
  mkdirSync(dir);
  for (const [file, [kind, level]] of Object.entries(files)) writeFileSync(path.join(dir, file), photo(kind, level));
  return dir;
}

describe("vivah undo", () => {
  const refs = shootWith("refs", { "ref.jpg": [0, 3] });

  it("puts a photographer's own sidecar back exactly, deletes the ones it created, and lets the edit be applied again", async () => {
    expect((await cli(["learn", "--refs", refs, "--name", "Warm", "--out", profile, "--provider", "mock"])).code).toBe(0);
    const shoot = shootWith("shoot-1", { "a.jpg": [0, 0], "b.jpg": [1, 0] });
    writeFileSync(path.join(shoot, "a.xmp"), own);
    const args = ["--folder", shoot, "--db", db, "--job", "j1"];

    const edited = await cli(["edit", ...args, "--profile", profile, "--provider", "mock"]);
    expect(edited.code).toBe(0);
    expect(edited.out).toContain("vivah undo --job j1");
    expect(readFileSync(path.join(shoot, "a.xmp"), "utf8")).toContain('crs:Exposure2012="+0.30"');
    expect(readFileSync(path.join(shoot, "a.xmp"), "utf8")).toContain('xmp:Label="Keeper"');
    expect(existsSync(path.join(shoot, "b.xmp"))).toBe(true);

    const dry = await cli(["undo", ...args, "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("1 file(s) would be put back");
    expect(dry.out).toContain("1 file(s) would be deleted");
    expect(readFileSync(path.join(shoot, "a.xmp"), "utf8")).toContain("crs:Exposure2012");

    const undone = await cli(["undo", ...args]);
    expect(undone.code).toBe(0);
    expect(readFileSync(path.join(shoot, "a.xmp"), "utf8")).toBe(own);
    expect(existsSync(path.join(shoot, "b.xmp"))).toBe(false);
    expect((await cli(["undo", ...args])).out).toContain("Everything was already undone");

    const again = await cli(["edit", ...args, "--profile", profile, "--provider", "mock"]);
    expect(again.out).toContain("LLM calls: 0");
    expect(readFileSync(path.join(shoot, "a.xmp"), "utf8")).toContain('crs:Exposure2012="+0.30"');
    expect(existsSync(path.join(shoot, "b.xmp"))).toBe(true);
  });

  it("leaves a sidecar the photographer kept editing alone, says so, and puts the original back only when forced", async () => {
    const shoot = shootWith("shoot-2", { "c.jpg": [2, 0] });
    writeFileSync(path.join(shoot, "c.xmp"), own);
    const args = ["--folder", shoot, "--db", db, "--job", "j2"];
    await cli(["edit", ...args, "--profile", profile, "--provider", "mock"]);
    const later = `${readFileSync(path.join(shoot, "c.xmp"), "utf8")}<!-- tweaked in Lightroom afterwards -->`;
    writeFileSync(path.join(shoot, "c.xmp"), later);

    const careful = await cli(["undo", ...args]);
    expect(careful.code).toBe(2);
    expect(careful.out).toContain("left alone");
    expect(careful.out).toContain("--force");
    expect(readFileSync(path.join(shoot, "c.xmp"), "utf8")).toBe(later);

    expect((await cli(["undo", ...args, "--force"])).code).toBe(0);
    expect(readFileSync(path.join(shoot, "c.xmp"), "utf8")).toBe(own);
  });

  it("explains when there is nothing to undo, and for an unknown job", async () => {
    const shoot = shootWith("shoot-3", { "d.jpg": [3, 0] });
    const store = await cli(["edit", "--folder", shoot, "--db", db, "--job", "j3", "--profile", profile, "--provider", "mock"]);
    expect(store.code).toBe(0);
    await cli(["undo", "--folder", shoot, "--db", db, "--job", "j3"]);
    expect((await cli(["undo", "--job", "nope", "--db", db])).out).toContain('No job "nope"');
    expect((await cli(["undo", "--db", db])).out).toContain("--folder or --job is required");
  });
});

describe("vivah edit --offline", () => {
  it("needs no model or key, reuses edits already made to the same files, and parks only the photos that need the model", async () => {
    const shoot = shootWith("shoot-4", { "e.jpg": [0, 1], "f.jpg": [1, 1] });
    const first = await cli(["edit", "--folder", shoot, "--db", db, "--job", "k1", "--profile", profile, "--provider", "mock"]);
    expect(first.out).toContain("2 ready for review");
    writeFileSync(path.join(shoot, "g.jpg"), photo(2, 1));

    const offline = await cli(["edit", "--folder", shoot, "--db", db, "--job", "k2", "--profile", profile, "--provider", "openai", "--model", "any", "--offline"]);

    expect(offline.code).toBe(0);
    expect(offline.out).toContain("Offline: nothing is sent anywhere");
    expect(offline.out).toContain("2 ready for review");
    expect(offline.out).toContain('waiting for the model: 1 photo(s)');
    expect(offline.out).toContain("LLM calls: 0");
    expect(existsSync(path.join(shoot, "g.xmp"))).toBe(false);

    const online = await cli(["edit", "--folder", shoot, "--db", db, "--job", "k2", "--profile", profile, "--provider", "mock"]);
    expect(online.out).toContain("3 ready for review");
    expect(online.out).toContain("LLM calls: 1");
    expect(existsSync(path.join(shoot, "g.xmp"))).toBe(true);
  });
});
