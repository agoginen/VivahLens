import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createCloudApi } from "../api.js";
import { MemoryCloudStore } from "../memoryStore.js";
import { isUsable } from "../plans.js";
import { SqliteCloudStore } from "../sqliteStore.js";
import type { CloudStore } from "../store.js";
import { applyPaddleEvent, reconcilePaddleSubscriptions, type BillingDeps } from "./apply.js";
import { InvalidPaddleEvent, interpretPaddleEvent, verifyPaddleSignature, type PaddleConfig } from "./paddle.js";

const SECRET = "pdl_ntfset_01h_testsecret";
const config: PaddleConfig = {
  prices: {
    pri_starter: { plan: "starter" },
    pri_pro: { plan: "pro" },
    pri_studio: { plan: "studio", adapters: ["xmp-sidecar", "lightroom-classic"] },
  },
};
const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

const sign = (body: string | Buffer, ts: number, secret = SECRET) => `ts=${ts};h1=${createHmac("sha256", secret).update(`${ts}:`).update(body).digest("hex")}`;

describe("verifyPaddleSignature", () => {
  const body = Buffer.from(JSON.stringify({ event_id: "evt_01", note: "héllo ✓" }), "utf8");
  const ts = Math.floor(T0 / 1000);
  const ok = (header: string | undefined, over: { toleranceSec?: number; nowMs?: number; raw?: Buffer; secret?: string } = {}) =>
    verifyPaddleSignature(over.raw ?? body, header, over.secret ?? SECRET, { nowMs: over.nowMs ?? T0, toleranceSec: over.toleranceSec });

  it("accepts the signature of exactly these bytes", () => {
    expect(ok(sign(body, ts))).toBe(true);
    expect(ok(sign(body, ts).toUpperCase().replace("TS=", "ts=").replace("H1=", "h1="))).toBe(true); // hex digits in either case
  });

  it("rejects a changed body, a wrong secret, and anything that is not a signature", () => {
    expect(ok(sign(body, ts), { raw: Buffer.from(`${body.toString()} `) })).toBe(false);
    expect(ok(sign(body, ts, "another-secret"))).toBe(false);
    expect(ok(undefined)).toBe(false);
    expect(ok("")).toBe(false);
    expect(ok("garbage")).toBe(false);
    expect(ok(`h1=${"0".repeat(64)}`)).toBe(false); // no timestamp
    expect(ok(`ts=${ts}`)).toBe(false); // no signature
    expect(ok(`ts=${ts};h1=not-hex`)).toBe(false);
    expect(ok(`ts=${ts};h1=abcd`)).toBe(false); // wrong length
    expect(ok(sign(body, ts), { secret: "" })).toBe(false);
  });

  it("rejects an old or far-future timestamp, so a captured event cannot be replayed, and honours a wider window when told to", () => {
    const old = sign(body, ts - 6);
    expect(ok(old)).toBe(false);
    expect(ok(sign(body, ts + 6))).toBe(false);
    expect(ok(sign(body, ts - 5))).toBe(true);
    expect(ok(old, { toleranceSec: 30 })).toBe(true);
    expect(ok(sign(body, ts), { nowMs: T0 + 60_000 })).toBe(false);
  });

  it("accepts the event if any signature matches, which is what a secret rotation sends", () => {
    const good = sign(body, ts).split("h1=")[1]!;
    expect(ok(`ts=${ts};h1=${"a".repeat(64)};h1=${good}`)).toBe(true);
    expect(ok(`ts=${ts};h1=${good};h1=${"a".repeat(64)}`)).toBe(true);
    expect(ok(`ts=${ts};h1=${"a".repeat(64)};h1=${"b".repeat(64)}`)).toBe(false);
  });
});

const subscription = (over: Record<string, unknown> = {}) => ({
  id: "sub_01abc",
  status: "active",
  customer_id: "ctm_01xyz",
  current_billing_period: { starts_at: iso(T0), ends_at: iso(T0 + 30 * DAY) },
  next_billed_at: iso(T0 + 30 * DAY),
  scheduled_change: null,
  canceled_at: null,
  paused_at: null,
  custom_data: { vl_account_id: "acct_1" },
  items: [{ status: "active", quantity: 1, price: { id: "pri_pro", product_id: "pro_1" }, trial_dates: null }],
  ...over,
});
let eventCounter = 0;
const event = (type: string, data: unknown, at = T0) => ({ event_id: `evt_${String(++eventCounter).padStart(26, "0")}`, event_type: type, occurred_at: iso(at), notification_id: "ntf_1", data });

describe("interpretPaddleEvent", () => {
  it("maps a subscription to a plan, seats, adapters and the end of what has been paid for", () => {
    const outcome = interpretPaddleEvent(event("subscription.created", subscription({ items: [{ status: "active", quantity: 3, price: { id: "pri_studio" } }] })), config);
    expect(outcome).toMatchObject({
      kind: "subscription",
      accountId: "acct_1",
      customerId: "ctm_01xyz",
      subscriptionId: "sub_01abc",
      occurredAt: T0,
      state: { plan: "studio", seats: 3, adapters: ["xmp-sidecar", "lightroom-classic"], status: "active", currentPeriodEnd: T0 + 30 * DAY },
    });
  });

  it("keeps access until a scheduled cancel takes effect, and ends it at the cancellation or pause time once it has", () => {
    const pending = interpretPaddleEvent(event("subscription.updated", subscription({ scheduled_change: { action: "cancel", effective_at: iso(T0 + 10 * DAY), resume_at: null } })), config);
    expect(pending).toMatchObject({ state: { status: "active", currentPeriodEnd: T0 + 10 * DAY } });

    const resumed = interpretPaddleEvent(event("subscription.updated", subscription({ scheduled_change: { action: "resume", effective_at: iso(T0 + 10 * DAY), resume_at: null } })), config);
    expect(resumed).toMatchObject({ state: { currentPeriodEnd: T0 + 30 * DAY } });

    const canceled = interpretPaddleEvent(event("subscription.canceled", subscription({ status: "canceled", current_billing_period: null, canceled_at: iso(T0 + 2 * DAY) })), config);
    expect(canceled).toMatchObject({ state: { status: "canceled", currentPeriodEnd: T0 + 2 * DAY } });

    const paused = interpretPaddleEvent(event("subscription.paused", subscription({ status: "paused", current_billing_period: null, paused_at: iso(T0 + 3 * DAY) })), config);
    expect(paused).toMatchObject({ state: { status: "paused", currentPeriodEnd: T0 + 3 * DAY } });
  });

  it("uses the trial's end for a trial that has no billing period yet", () => {
    const trial = interpretPaddleEvent(
      event("subscription.trialing", subscription({ status: "trialing", current_billing_period: null, next_billed_at: null, items: [{ status: "trialing", quantity: 1, price: { id: "pri_starter" }, trial_dates: { starts_at: iso(T0), ends_at: iso(T0 + 14 * DAY) } }] })),
      config,
    );
    expect(trial).toMatchObject({ state: { plan: "starter", status: "trialing", currentPeriodEnd: T0 + 14 * DAY } });
  });

  it("grants nothing for a price it does not know, and ignores events that are not about subscriptions", () => {
    expect(interpretPaddleEvent(event("subscription.created", subscription({ items: [{ status: "active", price: { id: "pri_unknown" } }] })), config)).toMatchObject({ kind: "ignored", reason: "unmapped-price" });
    expect(interpretPaddleEvent(event("subscription.created", subscription({ items: [{ status: "inactive", price: { id: "pri_pro" } }] })), config)).toMatchObject({ reason: "unmapped-price" });
    for (const type of ["transaction.completed", "customer.created", "subscription.imported", "address.updated"]) {
      expect(interpretPaddleEvent(event(type, { id: "x" }), config)).toMatchObject({ kind: "ignored", reason: "unrelated-event" });
    }
  });

  it("revokes only for an approved full refund or chargeback", () => {
    const adjustment = (over: Record<string, unknown>) => event("adjustment.updated", { id: "adj_1", action: "refund", type: "full", status: "approved", transaction_id: "txn_1", subscription_id: "sub_01abc", customer_id: "ctm_01xyz", ...over });
    expect(interpretPaddleEvent(adjustment({}), config)).toMatchObject({ kind: "revocation", subscriptionId: "sub_01abc", customerId: "ctm_01xyz" });
    expect(interpretPaddleEvent(adjustment({ action: "chargeback" }), config)).toMatchObject({ kind: "revocation" });
    for (const over of [{ status: "pending_approval" }, { status: "rejected" }, { type: "partial" }, { action: "credit" }, { action: "chargeback_warning" }, { action: "chargeback_reverse" }]) {
      expect(interpretPaddleEvent(adjustment(over), config), JSON.stringify(over)).toMatchObject({ kind: "ignored", reason: "not-a-revocation" });
    }
  });

  it("refuses an event that is not shaped like Paddle's, rather than guessing", () => {
    for (const bad of [null, "text", {}, { ...event("subscription.created", subscription()), event_id: "bad id" }, { ...event("subscription.created", subscription()), occurred_at: "yesterday" }]) {
      expect(() => interpretPaddleEvent(bad, config)).toThrow(InvalidPaddleEvent);
    }
    expect(() => interpretPaddleEvent(event("subscription.created", subscription({ status: "weird" })), config)).toThrow(InvalidPaddleEvent);
    expect(() => interpretPaddleEvent(event("subscription.created", subscription({ items: [] })), config)).toThrow(InvalidPaddleEvent);
    expect(() => interpretPaddleEvent(event("adjustment.created", { nope: true }), config)).toThrow(InvalidPaddleEvent);
  });
});

const dir = mkdtempSync(path.join(tmpdir(), "vivah-billing-"));
const opened: SqliteCloudStore[] = [];
afterAll(() => {
  for (const s of opened) s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.each<[string, () => CloudStore]>([
  ["MemoryCloudStore", () => new MemoryCloudStore()],
  [
    "SqliteCloudStore",
    () => {
      const s = new SqliteCloudStore(path.join(dir, `${Math.random().toString(36).slice(2)}.db`));
      opened.push(s);
      return s;
    },
  ],
])("applying billing events to %s", (_name, make) => {
  function setup() {
    const store = make();
    store.createAccount({ id: "acct_1", email: "a@example.com", createdAt: T0 });
    let clock = T0;
    const logs: { level: string; msg: string }[] = [];
    const deps: BillingDeps = { store, paddle: config, now: () => clock, log: (e) => void logs.push(e) };
    return { store, deps, logs, advance: (ms: number) => (clock += ms) };
  }

  it("creates the subscription from checkout's account id and links it for later events that do not carry one", () => {
    const { store, deps } = setup();
    expect(applyPaddleEvent(deps, event("subscription.created", subscription()))).toEqual({ result: "applied", accountId: "acct_1" });
    expect(store.getSubscription("acct_1")).toMatchObject({ plan: "pro", status: "active", currentPeriodEnd: T0 + 30 * DAY, billing: { provider: "paddle", customerId: "ctm_01xyz", subscriptionId: "sub_01abc", eventAt: T0 } });

    const renewal = event("subscription.updated", subscription({ custom_data: null, current_billing_period: { starts_at: iso(T0 + 30 * DAY), ends_at: iso(T0 + 60 * DAY) } }), T0 + 30 * DAY);
    expect(applyPaddleEvent(deps, renewal)).toMatchObject({ result: "applied", accountId: "acct_1" });
    expect(store.getSubscription("acct_1")!.currentPeriodEnd).toBe(T0 + 60 * DAY);
  });

  it("does nothing the second time it is delivered, and nothing when an older event arrives after a newer one", () => {
    const { store, deps } = setup();
    const created = event("subscription.created", subscription());
    const cancel = event("subscription.canceled", subscription({ status: "canceled", current_billing_period: null, canceled_at: iso(T0 + 5 * DAY) }), T0 + 5 * DAY);
    applyPaddleEvent(deps, created);
    applyPaddleEvent(deps, cancel);
    expect(applyPaddleEvent(deps, cancel)).toEqual({ result: "duplicate" });

    const lateUpdate = event("subscription.updated", subscription(), T0 + 1 * DAY);
    expect(applyPaddleEvent(deps, lateUpdate)).toEqual({ result: "stale", accountId: "acct_1" });
    expect(store.getSubscription("acct_1")).toMatchObject({ status: "canceled", currentPeriodEnd: T0 + 5 * DAY });
  });

  it("lets Paddle's retry through when applying failed, instead of swallowing it as a duplicate", () => {
    const { store, deps } = setup();
    const original = store.applyBillingSubscription.bind(store);
    let failures = 1;
    store.applyBillingSubscription = (s) => {
      if (failures-- > 0) throw new Error("disk full");
      return original(s);
    };
    const created = event("subscription.created", subscription());

    expect(() => applyPaddleEvent(deps, created)).toThrow("disk full");
    expect(applyPaddleEvent(deps, created)).toMatchObject({ result: "applied" });
  });

  it("will not guess the account of a customer it was never told about, and says why", () => {
    const { store, deps, logs } = setup();
    expect(applyPaddleEvent(deps, event("subscription.created", subscription({ custom_data: null })))).toEqual({ result: "ignored", reason: "unlinked-customer" });
    expect(applyPaddleEvent(deps, event("subscription.created", subscription({ custom_data: { vl_account_id: "acct_nope" } })))).toEqual({ result: "ignored", reason: "unknown-account" });
    expect(store.getSubscription("acct_1")).toBeUndefined();
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(2);
  });

  it("reports a price nobody mapped as an error, since a paying customer is getting nothing", () => {
    const { deps, logs } = setup();
    expect(applyPaddleEvent(deps, event("subscription.created", subscription({ items: [{ status: "active", price: { id: "pri_new_tier" } }] })))).toEqual({ result: "ignored", reason: "unmapped-price" });
    expect(logs.some((l) => l.level === "error" && /not mapped/.test(l.msg))).toBe(true);
  });

  it("does not let a late event about an old subscription cancel the one the customer started since", () => {
    const { store, deps } = setup();
    applyPaddleEvent(deps, event("subscription.created", subscription({ id: "sub_old" }), T0));
    applyPaddleEvent(deps, event("subscription.created", subscription({ id: "sub_new" }), T0 + 10 * DAY));

    const lateCancelOfOld = event("subscription.canceled", subscription({ id: "sub_old", status: "canceled", current_billing_period: null, canceled_at: iso(T0 + 11 * DAY) }), T0 + 11 * DAY);
    expect(applyPaddleEvent(deps, lateCancelOfOld)).toEqual({ result: "ignored", reason: "other-subscription" });
    expect(store.getSubscription("acct_1")).toMatchObject({ status: "active", billing: { subscriptionId: "sub_new" } });
  });

  it("cuts access off at once for a full refund or chargeback, and not for a partial one", () => {
    const { store, deps, advance } = setup();
    applyPaddleEvent(deps, event("subscription.created", subscription()));
    expect(isUsable(store.getSubscription("acct_1")!, T0 + DAY)).toBe(true);

    const partial = event("adjustment.created", { id: "adj_1", action: "refund", type: "partial", status: "approved", subscription_id: "sub_01abc" }, T0 + DAY);
    expect(applyPaddleEvent(deps, partial)).toEqual({ result: "ignored", reason: "not-a-revocation" });
    expect(isUsable(store.getSubscription("acct_1")!, T0 + DAY)).toBe(true);

    const full = event("adjustment.updated", { id: "adj_2", action: "refund", type: "full", status: "approved", subscription_id: "sub_01abc", customer_id: "ctm_01xyz" }, T0 + 2 * DAY);
    advance(2 * DAY);
    expect(applyPaddleEvent(deps, full)).toMatchObject({ result: "applied", accountId: "acct_1" });
    expect(store.getSubscription("acct_1")).toMatchObject({ status: "canceled", currentPeriodEnd: T0 + 2 * DAY });
    expect(isUsable(store.getSubscription("acct_1")!, T0 + 2 * DAY + 1)).toBe(false);

    expect(applyPaddleEvent(deps, event("adjustment.updated", { id: "adj_3", action: "refund", type: "full", status: "approved", subscription_id: "sub_unknown" }))).toEqual({ result: "ignored", reason: "unknown-subscription" });
  });

  it("keeps an operator's manual correction from losing the billing link, so the next event still finds the account", () => {
    const { store, deps } = setup();
    applyPaddleEvent(deps, event("subscription.created", subscription()));
    const stored = store.getSubscription("acct_1")!;
    const { billing: _link, ...manual } = stored;
    store.upsertSubscription({ ...manual, seats: 9, updatedAt: T0 + 1 });

    expect(store.getSubscription("acct_1")).toMatchObject({ seats: 9, billing: { subscriptionId: "sub_01abc" } });
    expect(applyPaddleEvent(deps, event("subscription.updated", subscription({ custom_data: null }), T0 + DAY))).toMatchObject({ result: "applied" });
    expect(store.findAccountByBilling("paddle", { customerId: "ctm_01xyz" })).toBe("acct_1");
    expect(store.findAccountByBilling("paddle", { subscriptionId: "sub_none" })).toBeUndefined();
  });

  it("repairs drift from a listing of Paddle's own subscriptions, treating each as the state right now", () => {
    const { store, deps, advance } = setup();
    applyPaddleEvent(deps, event("subscription.created", subscription({ custom_data: { vl_account_id: "acct_1" } })));
    advance(3 * DAY);

    const summary = reconcilePaddleSubscriptions(deps, [
      subscription({ status: "canceled", current_billing_period: null, canceled_at: iso(T0 + 2 * DAY) }),
      subscription({ id: "sub_other", customer_id: "ctm_other", custom_data: null }),
      subscription({ items: [{ status: "active", price: { id: "pri_unknown" } }] }),
      { id: "broken" },
    ]);

    expect(summary).toEqual({ applied: 1, stale: 0, ignored: 2, invalid: 1 });
    expect(store.getSubscription("acct_1")).toMatchObject({ status: "canceled", currentPeriodEnd: T0 + 2 * DAY });
    // A webhook from before the listing cannot undo it.
    expect(applyPaddleEvent(deps, event("subscription.updated", subscription(), T0 + DAY))).toMatchObject({ result: "stale" });
  });
});

describe("POST /webhooks/paddle", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((c) => c()));
  });
  let seed = 0;
  const randomBytes = (n: number) => {
    let out = Buffer.alloc(0);
    while (out.length < n) out = Buffer.concat([out, createHash("sha256").update(`billing-seed-${seed++}`).digest()]);
    return out.subarray(0, n);
  };

  async function start(opts: { paddle?: boolean; list?: () => Promise<unknown[]> } = { paddle: true }) {
    const store = new MemoryCloudStore();
    let clock = T0;
    const api = createCloudApi({
      store,
      signingKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      adminKey: "admin-key-for-tests-0123456789",
      webhookSecret: "legacy-secret",
      now: () => clock,
      randomBytes,
      ...(opts.paddle !== false && { paddle: { ...config, webhookSecret: SECRET, listSubscriptions: opts.list } }),
    });
    const server = await api.listen(0);
    closers.push(server.close);
    const base = `http://127.0.0.1:${server.port}`;
    const post = async (route: string, body: string, headers: Record<string, string>) => {
      const res = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined, contentType: res.headers.get("content-type") };
    };
    const paddle = (payload: unknown, over: { header?: string; ts?: number } = {}) => {
      const raw = JSON.stringify(payload);
      return post("/webhooks/paddle", raw, { "paddle-signature": over.header ?? sign(raw, over.ts ?? Math.floor(clock / 1000)) });
    };
    const admin = (route: string) => post(route, "", { authorization: "Bearer admin-key-for-tests-0123456789" });
    return { store, post, paddle, admin, advance: (ms: number) => (clock += ms) };
  }

  it("turns a purchase into a working license and a full refund into a locked-out one, with every refusal explained", async () => {
    const h = await start();
    h.store.createAccount({ id: "acct_1", email: "a@example.com", createdAt: T0 });

    const bad = await h.paddle(event("subscription.created", subscription()), { header: "ts=1;h1=00" });
    expect(bad).toMatchObject({ status: 401, contentType: "application/problem+json", json: { code: "INVALID_SIGNATURE" } });
    expect((await h.paddle(event("subscription.created", subscription()), { ts: Math.floor(T0 / 1000) - 60 })).status).toBe(401);
    expect(h.store.getSubscription("acct_1")).toBeUndefined();

    const created = await h.paddle(event("subscription.created", subscription()));
    expect(created).toMatchObject({ status: 200, json: { ok: true, result: "applied", accountId: "acct_1" } });
    expect(h.store.getSubscription("acct_1")).toMatchObject({ plan: "pro", status: "active" });

    const again = event("subscription.updated", subscription(), T0 + 1000);
    expect((await h.paddle(again)).json.result).toBe("applied");
    expect((await h.paddle(again)).json.result).toBe("duplicate");

    const refund = await h.paddle(event("adjustment.updated", { id: "adj_1", action: "refund", type: "full", status: "approved", subscription_id: "sub_01abc" }, T0 + 5000));
    expect(refund.json.result).toBe("applied");
    expect(h.store.getSubscription("acct_1")).toMatchObject({ status: "canceled" });
  });

  it("answers 400 for a signed body that is not an event, and 404 when Paddle is not configured", async () => {
    const h = await start();
    const notJson = "{broken";
    expect((await h.post("/webhooks/paddle", notJson, { "paddle-signature": sign(notJson, Math.floor(T0 / 1000)) })).status).toBe(400);
    expect(await h.paddle({ event_type: "subscription.created" })).toMatchObject({ status: 400, json: { code: "INVALID_REQUEST" } });

    const off = await start({ paddle: false });
    expect((await off.paddle(event("subscription.created", subscription()))).status).toBe(404);
  });

  it("reconciles on request when a lister is configured, and says it is not available when it is not", async () => {
    const h = await start({ paddle: true, list: async () => [subscription()] });
    h.store.createAccount({ id: "acct_1", email: "a@example.com", createdAt: T0 });
    expect(await h.admin("/admin/v1/billing/paddle/reconcile")).toMatchObject({ status: 200, json: { applied: 1, stale: 0, ignored: 0, invalid: 0 } });
    expect(h.store.getSubscription("acct_1")).toMatchObject({ status: "active" });

    const without = await start();
    expect((await without.admin("/admin/v1/billing/paddle/reconcile")).status).toBe(404);
  });
});
