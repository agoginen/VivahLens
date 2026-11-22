import type { CloudStore, Subscription } from "../store.js";
import { InvalidPaddleEvent, interpretPaddleEvent, type PaddleConfig, type PaddleOutcome } from "./paddle.js";

export type BillingResult =
  | { result: "applied"; accountId: string }
  /** A later event for this subscription was already applied, so this one changed nothing. */
  | { result: "stale"; accountId: string }
  | { result: "duplicate" }
  | { result: "ignored"; reason: string };

export interface BillingDeps {
  store: CloudStore;
  paddle: PaddleConfig;
  now(): number;
  log?(event: { level: "info" | "warn" | "error"; msg: string; [k: string]: unknown }): void;
}

const GRANTING = new Set(["active", "trialing", "past_due"]);

/** Applies what an interpreted event means to the account's subscription, honouring the order the events happened in. */
function applyOutcome(deps: BillingDeps, outcome: Exclude<PaddleOutcome, { kind: "ignored" }>): BillingResult {
  const { store, now, log } = deps;

  if (outcome.kind === "revocation") {
    const accountId = store.findAccountByBilling("paddle", { subscriptionId: outcome.subscriptionId, customerId: outcome.customerId });
    const existing = accountId ? store.getSubscription(accountId) : undefined;
    if (!accountId || !existing?.billing) {
      log?.({ level: "warn", msg: "billing revocation for an unknown subscription", eventId: outcome.eventId });
      return { result: "ignored", reason: "unknown-subscription" };
    }
    const revoked: Subscription & { billing: NonNullable<Subscription["billing"]> } = {
      ...existing,
      status: "canceled",
      currentPeriodEnd: outcome.occurredAt,
      updatedAt: now(),
      billing: { ...existing.billing, eventAt: outcome.occurredAt },
    };
    log?.({ level: "warn", msg: "access revoked by billing event", accountId, reason: outcome.reason });
    return store.applyBillingSubscription(revoked) ? { result: "applied", accountId } : { result: "stale", accountId };
  }

  // Our own account id from checkout wins; otherwise the account this Paddle customer or subscription was linked to before.
  const accountId = outcome.accountId ?? store.findAccountByBilling("paddle", { subscriptionId: outcome.subscriptionId, customerId: outcome.customerId });
  if (!accountId || !store.getAccount(accountId)) {
    log?.({ level: "warn", msg: "billing event for an account that cannot be identified", eventId: outcome.eventId, customerId: outcome.customerId });
    return { result: "ignored", reason: outcome.accountId ? "unknown-account" : "unlinked-customer" };
  }

  // A late event about an older subscription must not undo a newer one the customer started since.
  const existing = store.getSubscription(accountId);
  if (existing?.billing && existing.billing.subscriptionId !== outcome.subscriptionId && !GRANTING.has(outcome.state.status) && GRANTING.has(existing.status)) {
    return { result: "ignored", reason: "other-subscription" };
  }

  const subscription: Subscription & { billing: NonNullable<Subscription["billing"]> } = {
    accountId,
    ...outcome.state,
    updatedAt: now(),
    billing: { provider: "paddle", customerId: outcome.customerId, subscriptionId: outcome.subscriptionId, eventAt: outcome.occurredAt },
  };
  return store.applyBillingSubscription(subscription) ? { result: "applied", accountId } : { result: "stale", accountId };
}

/**
 * Handles one verified Paddle webhook. Delivery is at least once and unordered, so the event id is recorded (a repeat
 * does nothing) and an event older than the one already applied changes nothing. If applying fails the event id is
 * forgotten, so Paddle's retry is processed rather than swallowed as a duplicate. A malformed event throws
 * {@link InvalidPaddleEvent}.
 */
export function applyPaddleEvent(deps: BillingDeps, raw: unknown): BillingResult {
  const outcome = interpretPaddleEvent(raw, deps.paddle);
  if (outcome.kind === "ignored") {
    if (outcome.reason === "unmapped-price") deps.log?.({ level: "error", msg: "subscription price is not mapped to a plan, nothing was granted", eventId: outcome.eventId });
    return { result: "ignored", reason: outcome.reason };
  }
  const key = `paddle:${outcome.eventId}`;
  if (!deps.store.recordWebhookEvent(key, deps.now())) return { result: "duplicate" };
  try {
    return applyOutcome(deps, outcome);
  } catch (err) {
    deps.store.unrecordWebhookEvent(key);
    throw err;
  }
}

export interface ReconcileSummary {
  applied: number;
  stale: number;
  ignored: number;
  invalid: number;
}

/**
 * Repairs drift between Paddle and this server (a missed or unmapped webhook) from a listing of Paddle's own subscriptions
 * (the same shape as a webhook's `data`). Each is treated as the state of right now, so a webhook that happened before
 * the listing can no longer undo it.
 */
export function reconcilePaddleSubscriptions(deps: BillingDeps, snapshots: readonly unknown[]): ReconcileSummary {
  const summary: ReconcileSummary = { applied: 0, stale: 0, ignored: 0, invalid: 0 };
  const occurredAt = new Date(deps.now()).toISOString();
  snapshots.forEach((data, i) => {
    try {
      const outcome = interpretPaddleEvent({ event_id: `evt_reconcile${deps.now()}x${i}`, event_type: "subscription.updated", occurred_at: occurredAt, data }, deps.paddle);
      if (outcome.kind === "ignored") {
        summary.ignored++;
        return;
      }
      const { result } = applyOutcome(deps, outcome);
      if (result === "applied") summary.applied++;
      else if (result === "stale") summary.stale++;
      else summary.ignored++;
    } catch (err) {
      if (!(err instanceof InvalidPaddleEvent)) throw err;
      summary.invalid++;
    }
  });
  return summary;
}
