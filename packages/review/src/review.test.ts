import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryStore,
  type AssetRef,
  type EditorAdapter,
  type EditRecipe,
  type StyleProfile,
} from "@vivahlens/core";
import { startReviewServer, type ReviewServer } from "./server.js";
import { reviewPage } from "./ui.js";

const recipe = (exposure: number): EditRecipe => ({ version: "1.0", assetType: "photo", adjustments: { exposure, contrast: 5 } });
const assets: AssetRef[] = ["a.cr3", "b.cr3"].map((id) => ({ id, kind: "photo", path: `/shoot/${id}` }));
const profile: StyleProfile = { id: "p", name: "Warm", version: 1, summary: "", baseAdjustments: { exposure: 0 } };

function setup() {
  const store = new MemoryStore();
  store.ensureJob({ id: "j", name: "j", adapterId: "fake", styleProfileId: "p", createdAt: "" });
  for (const a of assets) store.putItem({ jobId: "j", assetId: a.id, state: "review", recipe: recipe(0.5), attempts: 0 });
  const applied: { id: string; exposure?: number }[] = [];
  const adapter: EditorAdapter = {
    id: "fake",
    capabilities: { mediaKinds: ["photo"], executionModel: "local-cli", requiresGuiOpen: false, os: ["windows"], supportedRecipeFields: ["exposure"] },
    detect: async () => ({}),
    applyRecipe: async (asset, r) => (applied.push({ id: asset.id, exposure: r.adjustments.exposure }), { assetId: asset.id, outputs: [] }),
  };
  const updates: StyleProfile[] = [];
  return { store, applied, updates, adapter };
}

let server: ReviewServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(s: ReturnType<typeof setup>) {
  server = await startReviewServer({
    store: s.store,
    jobId: "j",
    assets,
    adapter: s.adapter,
    profile,
    previewOf: async () => ({ mediaType: "image/jpeg", dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") }),
    onProfileUpdated: (p) => void s.updates.push(p),
  });
  const base = new URL(server.url);
  const token = base.searchParams.get("t")!;
  const api = (path: string, init?: RequestInit) => fetch(`${base.origin}${path}${path.includes("?") ? "&" : "?"}t=${token}`, init);
  return { base, token, api };
}

describe("review server", () => {
  it("embeds the token without letting it break out of the script tag", () => {
    const html = reviewPage("a</script><b>");
    expect(html.split("</script>")).toHaveLength(2);
  });

  it("lists items, serves previews and the page, and rejects missing or wrong tokens", async () => {
    const { base, api } = await start(setup());
    const items = (await (await api("/api/items")).json()) as { items: { id: string; state: string; unsupported: string[] }[] };
    expect(items.items.map((i) => [i.id, i.state])).toEqual([["a.cr3", "review"], ["b.cr3", "review"]]);
    expect(items.items[0]!.unsupported).toEqual(["contrast"]);

    const img = await api("/api/preview/a.cr3");
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect((await img.arrayBuffer()).byteLength).toBe(4);
    expect((await api("/")).headers.get("content-type")).toContain("text/html");

    expect((await fetch(`${base.origin}/api/items`)).status).toBe(401);
    expect((await fetch(`${base.origin}/api/items?t=wrong`)).status).toBe(401);
    expect((await api("/api/preview/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
  });

  it("rejects requests whose Host header is not loopback (DNS rebinding)", async () => {
    const { base, token } = await start(setup());
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: base.port, path: `/api/items?t=${token}`, headers: { host: "evil.example.com" } }, (r) => resolve(r.statusCode ?? 0))
        .on("error", reject);
    });
    expect(status).toBe(403);
  });

  it("applies overrides to approved photos, leaves the rest in review, and nudges the profile", async () => {
    const s = setup();
    const { api } = await start(s);
    const res = await api("/api/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve: ["a.cr3"], overrides: { "a.cr3": recipe(1) } }),
    });
    expect(await res.json()).toMatchObject({ approved: 1, exported: 0, failed: 0, profileVersion: 2 });

    expect(s.applied).toEqual([{ id: "a.cr3", exposure: 1 }]);
    expect(s.store.listItems("j").map((i) => [i.assetId, i.state])).toEqual([["a.cr3", "approved"], ["b.cr3", "review"]]);
    expect(s.updates[0]!.baseAdjustments.exposure).toBeCloseTo(0.2);
  });

  it("refuses non-JSON writes, malformed bodies and out-of-range recipes", async () => {
    const s = setup();
    const { api } = await start(s);
    expect((await api("/api/decide", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await api("/api/decide", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" })).status).toBe(400);
    const bad = await api("/api/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve: ["a.cr3"], overrides: { "a.cr3": recipe(99) } }),
    });
    expect(bad.status).toBe(400);
    expect(s.applied).toEqual([]);
  });
});
