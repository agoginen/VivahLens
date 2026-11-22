import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { afterAll, describe, expect, it, vi } from "vitest";
import { signEntitlement } from "@vivahlens/core";
import { runCli } from "./commands.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC = publicKey.export({ type: "spki", format: "pem" }) as string;
const DAY = 24 * 60 * 60 * 1000;

const root = mkdtempSync(path.join(tmpdir(), "vivah-access-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function photo(variant: number): Buffer {
  const [w, h] = [96, 64];
  const data = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.fill(Math.min(255, 50 + ((x + variant * 20) % w) * 2 + ((x + y) % 2) * 60), (y * w + x) * 4, (y * w + x) * 4 + 3);
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
}

let folders = 0;
function shoot(count = 3): string {
  const folder = path.join(root, `shoot${folders++}`);
  mkdirSync(folder);
  for (let i = 0; i < count; i++) writeFileSync(path.join(folder, `p${i}.jpg`), photo(i));
  return folder;
}

const profile = path.join(root, "style.profile.json");
const token = (over: Partial<Parameters<typeof signEntitlement>[0]> = {}) =>
  signEntitlement({ accountId: "a", plan: "pro", seats: 1, adapters: ["xmp-sidecar"], issuedAt: Date.now() - DAY, expiresAt: Date.now() + 5 * DAY, ...over }, privateKey);

function cli(args: string[], license?: string) {
  const lines: string[] = [];
  const env = { VIVAH_HOME: path.join(root, "home"), VIVAH_LICENSE_PUBLIC_KEY: PUBLIC, ...(license && { VIVAH_LICENSE: license }) };
  return runCli(args, { env, log: (l) => lines.push(l), info: (l) => void lines.push(l) }).then((code) => ({ code, out: lines.join("\n") }));
}
const editArgs = (folder: string, extra: string[] = []) => ["edit", "--folder", folder, "--profile", profile, "--provider", "mock", "--db", path.join(root, `${path.basename(folder)}.db`), ...extra];

describe("the trial's guided batch", () => {
  it("refuses a folder bigger than the trial allows before touching any photo, and says how to proceed", async () => {
    const folder = shoot(3);
    // The style profile is made once, with no license enforced (learning is not gated).
    const refs = shoot(1);
    expect(await runCli(["learn", "--refs", refs, "--name", "Style", "--out", profile, "--provider", "mock"], { env: { VIVAH_HOME: path.join(root, "home") }, log: () => undefined, info: () => undefined })).toBe(0);

    const trial = token({ plan: "trial", limits: { maxPhotosPerJob: 2 } });
    const refused = await cli(editArgs(folder), trial);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("[ENTITLEMENT_LIMIT] The trial plan covers up to 2 photos per batch and this folder has 3.");
    expect(existsSync(path.join(folder, "p0.xmp"))).toBe(false);

    const allowed = await cli(editArgs(folder), token({ plan: "trial", limits: { maxPhotosPerJob: 3 } }));
    expect(allowed.code).toBe(0);
    expect(existsSync(path.join(folder, "p0.xmp"))).toBe(true);
  });

  it("puts no cap on a paid plan", async () => {
    const folder = shoot(3);
    expect((await cli(editArgs(folder), token())).code).toBe(0);
  });
});

describe("a license that ran out", () => {
  it("keeps editing during the offline window, and says when it must reconnect", async () => {
    const folder = shoot(2);
    const result = await cli(editArgs(folder), token({ expiresAt: Date.now() - 3 * DAY }));
    expect(result.code).toBe(0);
    expect(result.out).toContain("it keeps working offline until");
  });

  it("pauses editing after the window but still exports, and leaves the photos untouched when it refuses", async () => {
    const folder = shoot(2);
    const lapsed = token({ expiresAt: Date.now() - 20 * DAY });
    const refused = await cli(editArgs(folder), lapsed);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("[ENTITLEMENT_EXPIRED]");
    expect(refused.out).toContain("You can still export, deliver and undo.");
    expect(existsSync(path.join(folder, "p0.xmp"))).toBe(false);

    // Work from before the lapse can be taken out: the license check passes and says editing is paused.
    const exported = await cli(["export", "--folder", folder, "--approve-all", "--db", path.join(root, "export.db")], lapsed);
    expect(exported.out).toContain("License: pro plan. Editing is paused: the saved license ran out on");
    expect(exported.out).not.toContain("[ENTITLEMENT");
  });

  it("opens the review page read-only: approving works, adjusting is refused", async () => {
    const folder = shoot(2);
    await cli(editArgs(folder, ["--job", "paused"]));
    // Edit once with a good license so there is something to review, then open the review with a lapsed one.
    const good = await cli(editArgs(folder, ["--job", "paused"]), token());
    expect(good.code).toBe(0);

    const abort = new AbortController();
    const lines: string[] = [];
    const running = runCli(["review", "--folder", folder, "--profile", profile, "--db", path.join(root, `${path.basename(folder)}.db`), "--job", "paused"], {
      env: { VIVAH_HOME: path.join(root, "home"), VIVAH_LICENSE_PUBLIC_KEY: PUBLIC, VIVAH_LICENSE: token({ expiresAt: Date.now() - 20 * DAY }) },
      log: (l) => lines.push(l),
      signal: abort.signal,
    });
    const url = await vi.waitFor(() => {
      const found = lines.join("\n").match(/http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/)?.[0];
      if (!found) throw new Error("server not up yet");
      return found;
    }, { timeout: 30_000 });
    const origin = new URL(url).origin;
    const t = new URL(url).searchParams.get("t")!;
    try {
      const listing = (await (await fetch(`${origin}/api/items?t=${t}`)).json()) as { editing: unknown; items: { id: string; recipe: unknown; state: string }[] };
      expect(listing.editing).toEqual({ allowed: false, reason: "expired" });

      const toEdit = listing.items.find((i) => i.state === "review" && i.recipe)!;
      const post = (body: unknown) => fetch(`${origin}/api/decide?t=${t}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const adjusted = await post({ approve: [toEdit.id], overrides: { [toEdit.id]: toEdit.recipe } });
      expect(adjusted.status).toBe(403);
      expect(await adjusted.json()).toMatchObject({ code: "EDITING_PAUSED", reason: "expired" });
      const approved = await post({ approve: [toEdit.id], overrides: {} });
      expect(approved.status).toBe(200);
    } finally {
      abort.abort();
    }
    expect(await running).toBe(0);
    expect(lines.join("\n")).toContain("Editing is paused");
  });
});

describe("video is a Pro feature", () => {
  it("refuses a rough cut on a plan without the video flag, before looking for ffmpeg", async () => {
    const clips = shoot(0);
    const refused = await cli(["cut", "--folder", clips], token({ adapters: ["xmp-sidecar"] }));
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('[ENTITLEMENT_INVALID] Plan "pro" does not include adapter "video-timeline"');
    // With the flag it gets as far as the next requirement.
    const allowed = await cli(["cut", "--folder", clips], token({ adapters: ["xmp-sidecar", "video-timeline"] }));
    expect(allowed.out).not.toContain("ENTITLEMENT");
  });
});
