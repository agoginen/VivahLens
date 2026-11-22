import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { boundedArray } from "@vivahlens/core";
import { DEFAULT_ADAPTERS } from "../plans.js";
import type { Plan, SubscriptionStatus } from "../store.js";

/**
 * Verifies the `Paddle-Signature` header (`ts=<unix seconds>;h1=<hex>`): HMAC-SHA256, keyed with the notification
 * destination's secret, over `<ts>:<raw body>`. More than one `h1` is sent while a secret is being rotated, and the event
 * is accepted if any of them matches. The timestamp must be within `toleranceSec` in both directions (Paddle's SDKs use 5 s),
 * which stops a captured event being replayed later. The body must be the bytes as received, never re-serialised.
 */
export function verifyPaddleSignature(rawBody: Buffer, header: string | undefined, secret: string, opts: { toleranceSec?: number; nowMs?: number } = {}): boolean {
  if (!header || !secret) return false;
  let ts = "";
  const candidates: string[] = [];
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === "ts") ts = value;
    else if (key === "h1") candidates.push(value);
  }
  if (!/^\d{1,12}$/.test(ts) || candidates.length === 0) return false;
  const nowMs = opts.nowMs ?? Date.now();
  if (Math.abs(nowMs - Number(ts) * 1000) > (opts.toleranceSec ?? 5) * 1000) return false;
  const expected = createHmac("sha256", secret).update(`${ts}:`).update(rawBody).digest();
  return candidates.some((h) => /^[0-9a-f]{64}$/i.test(h) && timingSafeEqual(expected, Buffer.from(h, "hex")));
}

export interface PaddleConfig {
  /** Which Paddle price is which plan. A subscription whose price is not listed is never granted anything. */
  prices: Record<string, { plan: Exclude<Plan, "trial">; adapters?: string[] }>;
}

const iso = z.string().datetime({ offset: true });
const Envelope = z.object({
  event_id: z.string().regex(/^evt_[A-Za-z0-9]{1,64}$/),
  event_type: z.string().min(1).max(100),
  occurred_at: iso,
  data: z.unknown(),
});

const SubscriptionData = z
  .object({
    id: z.string().regex(/^sub_[A-Za-z0-9]{1,64}$/),
    status: z.enum(["active", "trialing", "past_due", "paused", "canceled"]),
    customer_id: z.string().regex(/^ctm_[A-Za-z0-9]{1,64}$/),
    current_billing_period: z.object({ starts_at: iso, ends_at: iso }).nullable().optional(),
    next_billed_at: iso.nullable().optional(),
    scheduled_change: z.object({ action: z.enum(["cancel", "pause", "resume"]), effective_at: iso }).passthrough().nullable().optional(),
    canceled_at: iso.nullable().optional(),
    paused_at: iso.nullable().optional(),
    custom_data: z.record(z.unknown()).nullable().optional(),
    items: boundedArray(
      z
        .object({
          status: z.string().optional(),
          quantity: z.number().int().min(0).max(100_000).optional(),
          price: z.object({ id: z.string().min(1).max(100) }).passthrough(),
          trial_dates: z.object({ ends_at: iso }).passthrough().nullable().optional(),
        })
        .passthrough(),
      50,
      1,
    ),
  })
  .passthrough();

const AdjustmentData = z
  .object({
    id: z.string().min(1).max(100),
    action: z.string(),
    type: z.string().optional(),
    status: z.string(),
    transaction_id: z.string().optional(),
    subscription_id: z.string().nullable().optional(),
    customer_id: z.string().optional(),
  })
  .passthrough();

const SUBSCRIPTION_EVENTS = new Set(["created", "trialing", "activated", "updated", "past_due", "paused", "resumed", "canceled"]);

export interface PaddleSubscriptionState {
  plan: Plan;
  seats: number;
  adapters: string[];
  status: SubscriptionStatus;
  /** Until when this entitles the customer, in unix ms; null when Paddle gave no end. */
  currentPeriodEnd: number | null;
}

export type PaddleOutcome =
  | {
      kind: "subscription";
      eventId: string;
      occurredAt: number;
      /** Our account id from the checkout's `custom_data.vl_account_id`, if it was sent. */
      accountId?: string;
      customerId: string;
      subscriptionId: string;
      state: PaddleSubscriptionState;
    }
  | { kind: "revocation"; eventId: string; occurredAt: number; subscriptionId?: string; customerId?: string; reason: string }
  | { kind: "ignored"; eventId: string; reason: "unrelated-event" | "unmapped-price" | "not-a-revocation" };

export class InvalidPaddleEvent extends Error {}

/** When access ends for a status: Paddle's own access table (active/trialing/past_due full; paused/canceled none, except a change scheduled for later). */
function accessUntil(data: z.infer<typeof SubscriptionData>, occurredAt: number): number | null {
  const at = (s: string | null | undefined) => (s ? Date.parse(s) : null);
  if (data.status === "canceled") return at(data.canceled_at) ?? occurredAt;
  if (data.status === "paused") return at(data.paused_at) ?? occurredAt;
  const pending = data.scheduled_change && data.scheduled_change.action !== "resume" ? at(data.scheduled_change.effective_at) : null;
  const trialEnd = data.items.map((i) => at(i.trial_dates?.ends_at)).find((t) => t !== null && t !== undefined) ?? null;
  return pending ?? at(data.current_billing_period?.ends_at) ?? trialEnd ?? at(data.next_billed_at);
}

/**
 * Turns one verified Paddle webhook into what it means for entitlements, without touching any store. Refunds and
 * chargebacks arrive as `adjustment.*` events (there is no `transaction.refunded`); only an approved full refund or
 * chargeback revokes access. A malformed event throws {@link InvalidPaddleEvent}.
 */
export function interpretPaddleEvent(raw: unknown, config: PaddleConfig): PaddleOutcome {
  const envelope = Envelope.safeParse(raw);
  if (!envelope.success) throw new InvalidPaddleEvent(`event: ${envelope.error.issues[0]?.path.join(".") || "envelope"} is not valid`);
  const { event_id: eventId, event_type: type, occurred_at, data } = envelope.data;
  const occurredAt = Date.parse(occurred_at);

  if (type === "adjustment.created" || type === "adjustment.updated") {
    const adjustment = AdjustmentData.safeParse(data);
    if (!adjustment.success) throw new InvalidPaddleEvent("data: not a valid adjustment");
    const a = adjustment.data;
    const revokes = a.status === "approved" && a.type === "full" && (a.action === "refund" || a.action === "chargeback");
    if (!revokes) return { kind: "ignored", eventId, reason: "not-a-revocation" };
    return { kind: "revocation", eventId, occurredAt, ...(a.subscription_id && { subscriptionId: a.subscription_id }), ...(a.customer_id && { customerId: a.customer_id }), reason: `${a.action} ${a.id}` };
  }

  if (!type.startsWith("subscription.") || !SUBSCRIPTION_EVENTS.has(type.slice("subscription.".length))) {
    return { kind: "ignored", eventId, reason: "unrelated-event" };
  }
  const parsed = SubscriptionData.safeParse(data);
  if (!parsed.success) throw new InvalidPaddleEvent(`data.${parsed.error.issues[0]?.path.join(".") || "subscription"}: not valid`);
  const sub = parsed.data;

  const item = sub.items.find((i) => i.status !== "inactive" && config.prices[i.price.id]);
  if (!item) return { kind: "ignored", eventId, reason: "unmapped-price" };
  const mapped = config.prices[item.price.id]!;
  const accountId = typeof sub.custom_data?.vl_account_id === "string" ? sub.custom_data.vl_account_id : undefined;
  return {
    kind: "subscription",
    eventId,
    occurredAt,
    ...(accountId && { accountId }),
    customerId: sub.customer_id,
    subscriptionId: sub.id,
    state: {
      plan: mapped.plan,
      seats: Math.min(Math.max(item.quantity ?? 1, 1), 1000),
      adapters: mapped.adapters ?? DEFAULT_ADAPTERS[mapped.plan],
      status: sub.status,
      currentPeriodEnd: accessUntil(sub, occurredAt),
    },
  };
}
