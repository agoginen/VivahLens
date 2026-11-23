import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const root = mkdtempSync(path.join(tmpdir(), "vivah-studio-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = path.join(root, "home");
const refs = path.join(root, "finished");
const shoot = path.join(root, "shoot");
const out = path.join(root, "edited");
for (const dir of [refs, shoot]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(refs, "ref1.jpg"), photo({ sharp: true }));
writeFileSync(path.join(shoot, "a.jpg"), photo({ sharp: true }));
writeFileSync(path.join(shoot, "b.jpg"), photo({ sharp: true, reverse: true }));
writeFileSync(path.join(shoot, "soft.jpg"), photo({ sharp: false }));
const empty = path.join(root, "empty");
mkdirSync(empty);

const json = { "content-type": "application/json" };

/** Runs `vivah review` and gives back the page's address and a way to call its API. */
async function page(args: string[], extra: { env?: Record<string, string>; openUrl?: (url: string) => Promise<void> | void } = {}) {
  const abort = new AbortController();
  const lines: string[] = [];
  const running = runCli(["review", ...args], { env: { VIVAH_HOME: home, ...extra.env }, log: (l) => lines.push(l), info: (l) => lines.push(l), signal: abort.signal, ...(extra.openUrl && { openUrl: extra.openUrl }) });
  const url = await vi.waitFor(
    () => {
      const found = lines.join("\n").match(/http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/)?.[0];
      if (!found) throw new Error("server not up yet");
      return found;
    },
    { timeout: 30_000 },
  );
  const origin = new URL(url).origin;
  const token = new URL(url).searchParams.get("t")!;
  const api = (route: string, init?: RequestInit) => fetch(`${origin}${route}${route.includes("?") ? "&" : "?"}t=${token}`, init);
  const post = (route: string, body: unknown = {}) => api(route, { method: "POST", headers: json, body: JSON.stringify(body) });
  const workspace = async () => (await (await api("/api/workspace")).json()) as { phase: string; canStart: boolean; failure?: { message: string }; setup?: { outputUsed: boolean; defaults: Record<string, string>; providers: { id: string }[] } };
  const phase = (wanted: string) => vi.waitFor(async () => expect((await workspace()).phase).toBe(wanted), { timeout: 30_000 });
  const stop = async () => {
    abort.abort();
    return running;
  };
  return { url, lines, api, post, workspace, phase, stop };
}

describe("vivah review with no folders", () => {
  it("opens a page that asks for the folders, then learns the style, edits the shoot and opens it for review", async () => {
    const opened: string[] = [];
    const p = await page(["--db", path.join(root, "flow.db")], { openUrl: (url) => void opened.push(url) });
    try {
      expect(opened).toEqual([p.url]);
      const start = await p.workspace();
      expect(start).toMatchObject({ phase: "setup", canStart: true, setup: { outputUsed: true, defaults: { provider: "mock" } } });
      expect(start.setup!.providers.map((x) => x.id)).toEqual(["mock", "openai", "anthropic", "gemini", "ollama"]);

      const listing = (await (await p.api(`/api/browse?path=${encodeURIComponent(shoot)}`)).json()) as { photos: number };
      expect(listing.photos).toBe(3);

      const started = await p.post("/api/start", { input: shoot, output: out, profile: refs, provider: "mock" });
      expect(started.status).toBe(202);
      await p.phase("review");

      const items = (await (await p.api("/api/items")).json()) as { adapter: string; exportDir: string; items: { id: string; state: string }[] };
      expect(items).toMatchObject({ adapter: "builtin-render", exportDir: out });
      expect(items.items.map((i) => [i.id, i.state]).sort()).toEqual([["a.jpg", "review"], ["b.jpg", "review"], ["soft.jpg", "rejected"]]);

      // Several photos flagged for retouch in one request, then one approved and exported.
      const flagged = await p.post("/api/retouch", { ids: ["a.jpg", "b.jpg"], on: true });
      expect(await flagged.json()).toEqual({ done: ["a.jpg", "b.jpg"], skipped: [] });
      const decided = await p.post("/api/decide", { approve: ["a.jpg"], overrides: {} });
      expect(await decided.json()).toMatchObject({ exported: 1, approved: 0, failed: 0 });
      expect(readdirSync(out)).toEqual(["a.jpg"]);

      // The learned style is kept with the program's data, not among the photos delivered to the client.
      expect(existsSync(path.join(home, "styles", "finished.profile.json"))).toBe(true);
    } finally {
      expect(await p.stop()).toBe(0);
    }
  });

  it("goes back to the setup page for another shoot, and carries on from the work already done", async () => {
    const p = await page(["--db", path.join(root, "flow.db")]);
    try {
      expect((await p.post("/api/start", { input: shoot, output: out, profile: refs, provider: "mock" })).status).toBe(202);
      await p.phase("review");
      const again = await p.post("/api/reset");
      expect(await again.json()).toMatchObject({ phase: "setup" });
      expect((await p.api("/api/items")).status).toBe(409);
      expect((await p.post("/api/start", { input: shoot, output: out, profile: refs, provider: "mock" })).status).toBe(202);
      await p.phase("review");
      const items = (await (await p.api("/api/items")).json()) as { items: { id: string; state: string }[] };
      expect(items.items.find((i) => i.id === "a.jpg")?.state).toBe("exported");
    } finally {
      expect(await p.stop()).toBe(0);
    }
  });

  it("refuses folders that cannot work, naming the one to fix, before anything starts", async () => {
    const p = await page(["--db", path.join(root, "refuse.db")]);
    try {
      const refuse = async (body: Record<string, unknown>) => {
        const res = await p.post("/api/start", { input: shoot, output: out, profile: refs, provider: "mock", ...body });
        return [res.status, ((await res.json()) as { field?: string }).field];
      };
      expect(await refuse({ input: path.join(root, "nowhere") })).toEqual([400, "input"]);
      expect(await refuse({ input: empty })).toEqual([400, "input"]);
      expect(await refuse({ input: "relative/shoot" })).toEqual([400, "input"]);
      expect(await refuse({ input: path.join(shoot, "a.jpg") })).toEqual([400, "input"]);
      expect(await refuse({ profile: empty })).toEqual([400, "profile"]);
      expect(await refuse({ output: shoot })).toEqual([400, "output"]);
      expect(await refuse({ output: undefined })).toEqual([400, "output"]);
      expect(await refuse({ output: path.join(shoot, "a.jpg") })).toEqual([400, "output"]);
      expect(await refuse({ provider: "openai" })).toEqual([400, "model"]);
      expect(await refuse({ provider: "carrier-pigeon" })).toEqual([400, "provider"]);
      expect((await p.workspace()).phase).toBe("setup");
    } finally {
      expect(await p.stop()).toBe(0);
    }
  });

  it("says why an edit did not finish when a model's key is missing, and sends nothing", async () => {
    const p = await page(["--db", path.join(root, "nokey.db")]);
    try {
      await p.post("/api/start", { input: shoot, output: out, profile: refs, provider: "openai", model: "some-model" });
      await vi.waitFor(async () => expect((await p.workspace()).failure?.message).toContain("OPENAI_API_KEY is not set"), { timeout: 30_000 });
      expect((await p.workspace()).phase).toBe("setup");
    } finally {
      expect(await p.stop()).toBe(0);
    }
  });

  it("does not open a browser with --no-open, and says so when it cannot open one", async () => {
    const quiet: string[] = [];
    const a = await page(["--no-open"], { openUrl: (url) => void quiet.push(url) });
    expect(quiet).toEqual([]);
    expect(await a.stop()).toBe(0);

    const b = await page([], { openUrl: () => Promise.reject(new Error("no browser installed")) });
    expect(b.lines.join("\n")).toContain("Could not open your browser (no browser installed)");
    expect(await b.stop()).toBe(0);
  });

  it("starts from what the command line gave: folders, a model and an editor route", async () => {
    const p = await page(["--folder", shoot, "--export-dir", out, "--refs", refs, "--provider", "ollama", "--model", "llava", "--adapter", "xmp"]);
    try {
      const ws = await p.workspace();
      expect(ws.setup).toMatchObject({ outputUsed: false, defaults: { input: shoot, output: out, profile: refs, provider: "ollama", model: "llava" } });
      expect(ws.setup!.providers.map((x) => x.id)).toContain("ollama");
    } finally {
      expect(await p.stop()).toBe(0);
    }
  });
});

describe("vivah review with a folder and a profile", () => {
  it("still opens on the photos, and can start another shoot from there", async () => {
    // A job to look at: learn a style and edit once, the way the command line always did.
    const profile = path.join(root, "direct.profile.json");
    const db = path.join(root, "direct.db");
    const run = (args: string[]) => runCli(args, { env: { VIVAH_HOME: home }, log: () => undefined, info: () => undefined });
    expect(await run(["learn", "--refs", refs, "--name", "Direct", "--out", profile, "--provider", "mock"])).toBe(0);
    expect(await run(["edit", "--folder", shoot, "--profile", profile, "--provider", "mock", "--adapter", "render", "--db", db, "--job", "direct"])).toBe(0);

    const p = await page(["--folder", shoot, "--profile", profile, "--adapter", "render", "--export-dir", out, "--db", db, "--job", "direct"]);
    try {
      expect(await p.workspace()).toMatchObject({ phase: "review", canStart: true });
      expect(((await (await p.api("/api/items")).json()) as { job: string }).job).toBe("direct");
      expect(await (await p.post("/api/reset")).json()).toMatchObject({ phase: "setup" });
    } finally {
      expect(await p.stop()).toBe(0);
    }
  });
});
