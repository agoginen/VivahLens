import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { afterAll, describe, expect, it } from "vitest";
import type { ProcessRunner, RemoteConfig } from "@vivahlens/core";
import { readExposure } from "@vivahlens/adapter-darktable";
import { runCli } from "./commands.js";
import { adapterNotice, BUILT_IN_STAGES } from "./remoteConfigClient.js";

const root = mkdtempSync(path.join(tmpdir(), "vivah-dtcli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function photo(variant: number, size: [number, number] = [96, 64]): Buffer {
  const [w, h] = size;
  const data = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.fill(Math.min(255, 50 + (variant ? w - 1 - x : x) * 2 + ((x + y) % 2) * 60), (y * w + x) * 4, (y * w + x) * 4 + 3);
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
}

/** Stands in for darktable-cli: reports a version, and writes a JPEG where an export is pointed. */
function fakeDarktable(version = "5.6.2"): { run: ProcessRunner; exports: string[][] } {
  const exports: string[][] = [];
  const run: ProcessRunner = async (_command, args) => {
    if (args[0] === "--version") return { code: 0, stdout: `this is darktable ${version}`, stderr: "" };
    exports.push([...args]);
    writeFileSync(args[args.indexOf("--out-ext") - 1]!, photo(0, [600, 400]));
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, exports };
}

let n = 0;
function setup() {
  const dir = path.join(root, `w${n++}`);
  const shoot = path.join(dir, "shoot");
  const refs = path.join(dir, "refs");
  mkdirSync(shoot, { recursive: true });
  mkdirSync(refs, { recursive: true });
  // Raw files that carry a preview the agent can read: here the whole file is one.
  writeFileSync(path.join(shoot, "IMG_0412.NEF"), photo(0));
  writeFileSync(path.join(shoot, "IMG_0413.NEF"), photo(1));
  writeFileSync(path.join(refs, "r.jpg"), photo(0));
  const env = { VIVAH_HOME: path.join(dir, "home") };
  const lines: string[] = [];
  const run = (args: string[], runner?: ProcessRunner) => runCli(args, { env, log: (l) => lines.push(l), info: (l) => lines.push(l), ...(runner && { run: runner }) });
  const profile = path.join(dir, "style.json");
  return { dir, shoot, refs, env, lines, run, profile, db: path.join(dir, "jobs.db"), text: () => lines.join("\n") };
}

async function learned(s: ReturnType<typeof setup>) {
  expect(await s.run(["learn", "--refs", s.refs, "--name", "S", "--out", s.profile, "--provider", "mock"])).toBe(0);
}

describe("vivah edit --adapter darktable", () => {
  it("writes a darktable sidecar for each raw file, says the adapter is beta and what to do in darktable, and lists what it ignores", async () => {
    const s = setup();
    await learned(s);
    const dt = fakeDarktable();
    const code = await s.run(["edit", "--folder", s.shoot, "--profile", s.profile, "--provider", "mock", "--adapter", "darktable", "--db", s.db, "--job", "j"], dt.run);
    expect(code).toBe(0);
    const text = s.text();
    expect(text).toContain('"darktable" is in beta. Written from darktable\'s source and not yet run against a real install');
    expect(text).toContain("2 ready for review");
    expect(text).toContain("adapter ignores");
    expect(text).toContain('Open darktable and import this folder to see the edits.');

    for (const name of ["IMG_0412.NEF.xmp", "IMG_0413.NEF.xmp"]) {
      const xml = readFileSync(path.join(s.shoot, name), "utf8");
      // The mock style asks for +0.3 EV; on top of darktable's own +0.7 that is exactly +1.0.
      const hex = /darktable:operation="exposure"[^>]*darktable:params="([0-9a-f]+)"/.exec(xml)![1]!;
      expect(readExposure(hex)!.exposure).toBeCloseTo(1.0, 5);
      expect(hex).toBe("00000000000080b90000803f00004842000080c00100000001000000");
    }
  });

  it("exports through darktable-cli and finishes each file for delivery", async () => {
    const s = setup();
    await learned(s);
    const dt = fakeDarktable();
    const base = ["--folder", s.shoot, "--adapter", "darktable", "--db", s.db, "--job", "j"];
    await s.run(["edit", ...base.slice(0, 2), "--profile", s.profile, "--provider", "mock", ...base.slice(2)], dt.run);
    const out = path.join(s.dir, "out");
    s.lines.length = 0;
    const code = await s.run(["export", ...base, "--approve-all", "--export-dir", out, "--preset", "web", "--max-edge", "300"], dt.run);
    expect(code).toBe(0);
    expect(s.text()).toContain("Exported 2 photo(s)");
    expect(readdirSync(out).sort()).toEqual(["IMG_0412.jpg", "IMG_0413.jpg"]);
    expect(dt.exports).toHaveLength(2);
    // darktable was asked to keep to the size, and the sidecar was handed over.
    expect(dt.exports[0]).toEqual(expect.arrayContaining(["--width", "300", "--height", "300"]));
    expect(dt.exports[0]![1]).toBe(path.join(s.shoot, "IMG_0412.NEF.xmp"));
  });

  it("undoes what it wrote, putting back the photographer's own sidecar", async () => {
    const s = setup();
    await learned(s);
    const own = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:darktable="http://darktable.sf.net/" xmp:Rating="5" darktable:xmp_version="5" darktable:history_end="0" darktable:iop_order_version="4"><darktable:history><rdf:Seq/></darktable:history></rdf:Description></rdf:RDF></x:xmpmeta>`;
    writeFileSync(path.join(s.shoot, "IMG_0412.NEF.xmp"), own);
    const dt = fakeDarktable();
    await s.run(["edit", "--folder", s.shoot, "--profile", s.profile, "--provider", "mock", "--adapter", "darktable", "--db", s.db, "--job", "j"], dt.run);
    expect(readFileSync(path.join(s.shoot, "IMG_0412.NEF.xmp"), "utf8")).toContain("darktable:operation=\"exposure\"");
    expect(await s.run(["undo", "--job", "j", "--db", s.db])).toBe(0);
    expect(readFileSync(path.join(s.shoot, "IMG_0412.NEF.xmp"), "utf8")).toBe(own);
    // The sidecar VivahLens made from nothing is removed again.
    expect(existsSync(path.join(s.shoot, "IMG_0413.NEF.xmp"))).toBe(false);
  });

  it("stops the whole batch with one clear message when the installed darktable is too old, and writes nothing", async () => {
    const s = setup();
    await learned(s);
    const old = fakeDarktable("5.4.1");
    const code = await s.run(["edit", "--folder", s.shoot, "--profile", s.profile, "--provider", "mock", "--adapter", "darktable", "--db", s.db, "--job", "j"], old.run);
    expect(code).toBe(2);
    expect(s.text()).toContain("stopped early: [ADAPTER_VERSION_UNSUPPORTED] darktable 5.4.1 is older than 5.6");
    expect(existsSync(path.join(s.shoot, "IMG_0412.NEF.xmp"))).toBe(false);
    expect(existsSync(path.join(s.shoot, "IMG_0413.NEF.xmp"))).toBe(false);
  });

  it("explains when darktable is not installed", async () => {
    const s = setup();
    await learned(s);
    const code = await s.run(["edit", "--folder", s.shoot, "--profile", s.profile, "--provider", "mock", "--adapter", "darktable", "--db", s.db, "--job", "j"], async () => ({ code: 127, stdout: "", stderr: "" }));
    expect(code).toBe(1);
    expect(s.text()).toContain("[ADAPTER_EDITOR_NOT_RUNNING] darktable was not found on this machine");
  });

  it("is named in the help and in the unknown-adapter message", async () => {
    const s = setup();
    await s.run(["--help"]);
    expect(s.text()).toContain("--adapter xmp|rawtherapee|darktable|lightroom|render");
    expect(s.text()).toContain("DARKTABLE_CLI");
    const unknown = setup();
    await learned(unknown);
    expect(await unknown.run(["edit", "--folder", unknown.shoot, "--profile", unknown.profile, "--provider", "mock", "--adapter", "capture-one", "--db", unknown.db])).toBe(1);
    expect(unknown.text()).toContain("Use xmp, rawtherapee, darktable, lightroom or render.");
  });
});

describe("which adapters are beta", () => {
  const config = (adapters: RemoteConfig["adapters"]): RemoteConfig => ({ schema: 1, sequence: 1, issuedAt: "2026-01-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z", adapters });

  it("marks the three adapters that have never been run against the real editor, and none of the others", () => {
    expect(Object.keys(BUILT_IN_STAGES).sort()).toEqual(["darktable", "lightroom-classic", "rawtherapee"]);
    for (const id of Object.keys(BUILT_IN_STAGES)) expect(adapterNotice(undefined, id).note).toMatch(new RegExp(`^"${id}" is in beta\\. `));
    for (const id of ["xmp-sidecar", "builtin-render", "video-timeline"]) expect(adapterNotice(undefined, id)).toEqual({});
  });

  it("lets a signed config promote a beta adapter to stable, switch it off, or add a note to it", () => {
    expect(adapterNotice(config({ darktable: { stage: "stable" } }), "darktable")).toEqual({});
    expect(adapterNotice(config({ darktable: { stage: "disabled", notice: "Paused after 5.8 changed the exposure module." } }), "darktable")).toEqual({ blocked: "Paused after 5.8 changed the exposure module." });
    expect(adapterNotice(config({ darktable: { stage: "disabled" } }), "darktable")).toEqual({ blocked: '"darktable" is switched off for now.' });
    expect(adapterNotice(config({ rawtherapee: { stage: "beta", notice: "Checked with 5.13." } }), "rawtherapee")).toEqual({ note: '"rawtherapee" is in beta. Checked with 5.13.' });
    // What the config does not mention keeps the build's own stage; and a config can mark any adapter beta.
    expect(adapterNotice(config({ darktable: { stage: "stable" } }), "rawtherapee").note).toContain("is in beta");
    expect(adapterNotice(config({ "xmp-sidecar": { stage: "beta" } }), "xmp-sidecar")).toEqual({ note: '"xmp-sidecar" is in beta.' });
  });
});
