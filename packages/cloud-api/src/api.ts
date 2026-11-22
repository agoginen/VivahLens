import { createHmac, createPrivateKey, randomBytes as nodeRandomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { boundedArray, signEntitlement } from "@vivahlens/core";
import { applyPaddleEvent, reconcilePaddleSubscriptions } from "./billing/apply.js";
import { InvalidPaddleEvent, verifyPaddleSignature, type PaddleConfig } from "./billing/paddle.js";
import { newId, newLicenseKey, newToken, normalizeLicenseKey, safeEqual, sha256Hex, type RandomBytes } from "./crypto.js";
import { DAY_MS, DEFAULT_ADAPTERS, entitlementExpiry, isUsable, limitsFor } from "./plans.js";
import { RateLimiter } from "./rateLimit.js";
import type { Activation, CloudStore, License, Subscription } from "./store.js";

export interface CloudApiDeps {
  store: CloudStore;
  /** Ed25519 private key (PEM) that signs entitlement tokens; clients verify with the matching public key. */
  signingKeyPem: string;
  adminKey: string;
  webhookSecret: string;
  /** Paddle Billing: enables `POST /webhooks/paddle`. Without it that route does not exist. */
  paddle?: PaddleConfig & {
    /** The notification destination's secret (`pdl_ntfset_…`). */
    webhookSecret: string;
    /** How far the signature timestamp may differ from now, in seconds (default 5, as in Paddle's SDKs). */
    toleranceSec?: number;
    /** Lists Paddle's own subscriptions for `POST /admin/v1/billing/paddle/reconcile`. */
    listSubscriptions?(): Promise<unknown[]>;
  };
  now?: () => number;
  randomBytes?: RandomBytes;
  /** Trust the first `x-forwarded-for` entry as the client address (only behind a proxy you control). */
  trustProxy?: boolean;
  /** Receives metadata-only events; never secrets. */
  logger?: (event: { level: "info" | "warn" | "error"; msg: string; [k: string]: unknown }) => void;
  /** Per-client abuse limits (attempts per minute). The defaults suit production; raise them for load tests. */
  rateLimits?: Partial<RateLimits>;
}

export interface RateLimits {
  activatePerMinute: number;
  failedActivationsPerMinute: number;
  refreshPerIpPerMinute: number;
  refreshPerTokenPerMinute: number;
  documentsPerIpPerMinute: number;
}

const DEFAULT_LIMITS: RateLimits = { activatePerMinute: 10, failedActivationsPerMinute: 5, refreshPerIpPerMinute: 120, refreshPerTokenPerMinute: 60, documentsPerIpPerMinute: 120 };

const MAX_BODY_BYTES = 256 * 1024;
const HARD_BODY_CEILING = 1024 * 1024;
const MINUTE = 60_000;
/** A manifest or config is a few kilobytes; this is generous and keeps the base64 form inside the body limit. */
const MAX_DOCUMENT_BYTES = 150 * 1024;
const DOCUMENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PublishSchema = z
  .object({
    bytesBase64: z.string().min(4).max(Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 4),
    signature: z.object({ kid: z.string().min(1).max(64), alg: z.literal("Ed25519"), sig: z.string().length(88) }).strict(),
  })
  .strict();

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

const badRequest = (message: string) => new ApiError(400, "INVALID_REQUEST", message);
const invalidToken = () => new ApiError(401, "INVALID_TOKEN", "The token is not valid.");
const rateLimited = (retryAfterSec: number) =>
  new ApiError(429, "RATE_LIMITED", "Too many requests. Try again later.", { "retry-after": String(retryAfterSec) });

const deviceText = z.string().trim().min(1).max(100);
const ActivateSchema = z.object({ licenseKey: z.string().min(1).max(64), deviceId: z.string().trim().min(8).max(128), deviceName: deviceText }).strict();
const UsageEventSchema = z
  .object({
    eventId: z.string().min(1).max(64),
    at: z.string().datetime({ offset: true }),
    photos: z.number().int().min(0).max(100_000),
    llmCalls: z.number().int().min(0).max(1_000_000),
    inputTokens: z.number().int().min(0).max(1_000_000_000),
    outputTokens: z.number().int().min(0).max(1_000_000_000),
    costUsd: z.number().min(0).max(100_000),
  })
  .strict();
const UsageSchema = z.object({ events: boundedArray(UsageEventSchema, 500, 1) }).strict();
const ProfileBodySchema = z.object({ name: z.string().trim().min(1).max(100), blob: z.string().max(400_000) }).strict();
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const adapterId = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const SubscriptionDataSchema = z
  .object({
    accountId: z.string().max(64).optional(),
    email: z.string().email().max(254).optional(),
    plan: z.enum(["trial", "starter", "pro", "studio"]),
    seats: z.number().int().min(1).max(1000),
    status: z.enum(["active", "trialing", "past_due", "paused", "canceled"]),
    currentPeriodEnd: z.string().datetime({ offset: true }).nullable().optional(),
    adapters: boundedArray(adapterId, 20).optional(),
  })
  .strict();
const WebhookSchema = z.object({ id: z.string().min(1).max(128), type: z.string().min(1).max(64), data: z.unknown() });

/** Licensing server: activation, short-lived signed entitlements, usage metering, billing webhooks and style-profile sync. */
export function createCloudApi(deps: CloudApiDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const rb = deps.randomBytes ?? nodeRandomBytes;
  const signingKey = createPrivateKey(deps.signingKeyPem);
  const limiter = new RateLimiter(now);
  const limits = { ...DEFAULT_LIMITS, ...deps.rateLimits };
  const log = deps.logger ?? (() => undefined);

  const server = http.createServer((req, res) => {
    const started = now();
    const requestId = newId("req", rb);
    res.setHeader("x-request-id", requestId);
    handle(req, res)
      .catch((err: unknown) => {
        if (err instanceof ApiError) return sendProblem(res, err.status, err.code, err.message, requestId, err.headers);
        log({ level: "error", msg: "unhandled error", requestId, error: err instanceof Error ? err.name : "unknown" });
        return sendProblem(res, 500, "INTERNAL_ERROR", "Something went wrong.", requestId);
      })
      .finally(() => log({ level: "info", msg: "request", requestId, method: req.method, status: res.statusCode, ms: now() - started }));
  });

  function clientIp(req: http.IncomingMessage): string {
    if (deps.trustProxy) {
      const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  async function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > HARD_BODY_CEILING) {
        req.destroy();
        throw new ApiError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.", { connection: "close" });
      }
      if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer);
    }
    if (size > MAX_BODY_BYTES) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    return Buffer.concat(chunks);
  }

  async function readBody(req: http.IncomingMessage): Promise<string> {
    return (await readRawBody(req)).toString("utf8");
  }

  function requireJson(req: http.IncomingMessage): void {
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
    }
  }

  function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: string): T {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw badRequest("The body is not valid JSON.");
    }
    const result = schema.safeParse(json);
    if (!result.success) throw badRequest(result.error.issues[0] ? `${result.error.issues[0].path.join(".") || "body"}: ${result.error.issues[0].message}` : "Invalid request.");
    return result.data;
  }

  const bearer = (req: http.IncomingMessage): string | undefined => /^Bearer (\S{1,512})$/.exec(String(req.headers.authorization ?? ""))?.[1];

  function requireAdmin(req: http.IncomingMessage): void {
    const token = bearer(req);
    if (!token || !safeEqual(token, deps.adminKey)) throw new ApiError(401, "UNAUTHORIZED", "Admin credentials are required.");
  }

  function issue(sub: Subscription): { entitlementToken: string; expiresAt: number } {
    const t = now();
    const expiresAt = entitlementExpiry(sub, t);
    const limits = limitsFor(sub.plan);
    const entitlementToken = signEntitlement(
      { accountId: sub.accountId, plan: sub.plan, seats: sub.seats, adapters: sub.adapters, issuedAt: t, expiresAt, ...(limits && { limits }) },
      signingKey,
    );
    return { entitlementToken, expiresAt };
  }

  function usableSubscription(accountId: string): Subscription {
    const sub = store.getSubscription(accountId);
    if (!sub || !isUsable(sub, now())) throw new ApiError(402, "SUBSCRIPTION_INACTIVE", "The subscription is not active.");
    return sub;
  }

  /** Resolves a refresh token to a live activation and its license, or fails with a generic 401. */
  function authenticate(req: http.IncomingMessage): { activation: Activation; license: License; token: string } {
    const token = bearer(req);
    if (!token) throw invalidToken();
    const hash = sha256Hex(token);
    const ip = limiter.hit(`refresh-ip:${clientIp(req)}`, limits.refreshPerIpPerMinute, MINUTE);
    const perToken = limiter.hit(`refresh-token:${hash.slice(0, 16)}`, limits.refreshPerTokenPerMinute, MINUTE);
    if (!ip.allowed || !perToken.allowed) throw rateLimited(Math.max(ip.retryAfterSec, perToken.retryAfterSec));
    const activation = store.getActivationByRefreshHash(hash);
    const license = activation && store.getLicense(activation.licenseId);
    if (!activation || activation.revokedAt !== null || !license || license.revokedAt !== null) throw invalidToken();
    return { activation, license, token };
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (method === "GET" && path === "/healthz") return send(res, 200, { ok: true });
    if (method === "POST" && path === "/webhooks/billing") return webhook(req, res);
    if (method === "POST" && path === "/webhooks/paddle") return paddleWebhook(req, res);
    if (path.startsWith("/admin/v1/")) return admin(req, res, method, path);
    if (path.startsWith("/v1/")) return client(req, res, method, path);
    throw new ApiError(404, "NOT_FOUND", "Not found.");
  }

  async function client(req: http.IncomingMessage, res: http.ServerResponse, method: string, path: string): Promise<void> {
    // Public and static: a signed document is useful to anyone and trusted by nobody until its signature is checked.
    const hosted = /^\/v1\/documents\/([a-z0-9][a-z0-9-]{0,39})(\.sig)?$/.exec(path);
    if (method === "GET" && hosted) return serveDocument(req, res, hosted[1]!, hosted[2] !== undefined);

    if (method === "POST" && path === "/v1/activate") {
      const ip = clientIp(req);
      const attempt = limiter.hit(`activate:${ip}`, limits.activatePerMinute, MINUTE);
      if (!attempt.allowed) throw rateLimited(attempt.retryAfterSec);
      const failures = limiter.exhausted(`activate-fail:${ip}`, limits.failedActivationsPerMinute, MINUTE);
      if (failures.blocked) throw rateLimited(failures.retryAfterSec);

      requireJson(req);
      const body = parse(ActivateSchema, await readBody(req));
      const key = normalizeLicenseKey(body.licenseKey);
      const license = key ? store.getLicenseByKeyHash(sha256Hex(key)) : undefined;
      if (!license || license.revokedAt !== null) {
        limiter.hit(`activate-fail:${ip}`, limits.failedActivationsPerMinute, MINUTE);
        throw new ApiError(401, "INVALID_LICENSE", "The license key is not valid.");
      }
      const sub = usableSubscription(license.accountId);

      // Check-and-write below has no await in between, so concurrent activations cannot overshoot the device cap.
      const live = store.listActivations(license.id).filter((a) => a.revokedAt === null);
      if (!live.some((a) => a.deviceId === body.deviceId) && live.length >= license.maxDevices) {
        throw new ApiError(409, "DEVICE_LIMIT_REACHED", `This license is already active on ${license.maxDevices} device(s). Deactivate one first.`);
      }
      const refreshToken = newToken(rb);
      const t = now();
      const activation = store.upsertActivation({
        id: newId("act", rb),
        licenseId: license.id,
        deviceId: body.deviceId,
        deviceName: body.deviceName,
        refreshTokenHash: sha256Hex(refreshToken),
        createdAt: t,
        lastSeenAt: t,
        revokedAt: null,
      });
      return send(res, 200, { ...issue(sub), refreshToken, activationId: activation.id });
    }

    if (method === "POST" && path === "/v1/refresh") {
      const { activation, license } = authenticate(req);
      const sub = usableSubscription(license.accountId);
      store.touchActivation(activation.id, now());
      return send(res, 200, issue(sub));
    }

    if (method === "POST" && path === "/v1/deactivate") {
      const { activation } = authenticate(req);
      store.revokeActivation(activation.id, now());
      return send(res, 204);
    }

    if (method === "POST" && path === "/v1/usage") {
      const { activation } = authenticate(req);
      requireJson(req);
      const { events } = parse(UsageSchema, await readBody(req));
      const t = now();
      const records = events.map((e) => {
        const at = Date.parse(e.at);
        if (Math.abs(at - t) > 2 * DAY_MS) throw badRequest("at: timestamp is too far from the current time");
        return { activationId: activation.id, eventId: e.eventId, at, photos: e.photos, llmCalls: e.llmCalls, inputTokens: e.inputTokens, outputTokens: e.outputTokens, costUsd: e.costUsd };
      });
      return send(res, 200, store.recordUsage(records));
    }

    const profileMatch = /^\/v1\/style-profiles(?:\/([^/]+))?$/.exec(path);
    if (profileMatch) {
      const { license } = authenticate(req);
      usableSubscription(license.accountId);
      const id = profileMatch[1];
      if (id !== undefined && !PROFILE_ID.test(id)) throw badRequest("profileId is not valid.");

      if (method === "GET" && id === undefined) {
        const profiles = store.listStyleProfiles(license.accountId).map((p) => ({ profileId: p.profileId, name: p.name, version: p.version, etag: etag(p.version), updatedAt: p.updatedAt }));
        return send(res, 200, { profiles });
      }
      if (method === "GET" && id !== undefined) {
        const p = store.getStyleProfile(license.accountId, id);
        if (!p) throw new ApiError(404, "NOT_FOUND", "No such style profile.");
        return send(res, 200, { profileId: p.profileId, name: p.name, version: p.version, etag: etag(p.version), blob: p.blob, updatedAt: p.updatedAt }, { etag: etag(p.version) });
      }
      if (method === "PUT" && id !== undefined) {
        requireJson(req);
        const body = parse(ProfileBodySchema, await readBody(req));
        if (!isBase64(body.blob) || decodedLength(body.blob) > MAX_BODY_BYTES) throw badRequest("blob: must be base64 and at most 256 KB when decoded");

        const existing = store.getStyleProfile(license.accountId, id);
        const ifMatch = req.headers["if-match"];
        const ifNoneMatch = req.headers["if-none-match"];
        let expected: number | null;
        if (!existing) {
          if (ifNoneMatch === undefined && ifMatch === undefined) throw new ApiError(428, "PRECONDITION_REQUIRED", "Creating a profile requires If-None-Match: *.");
          if (ifNoneMatch !== "*") throw new ApiError(412, "VERSION_CONFLICT", "The profile does not exist.");
          expected = null;
        } else {
          if (ifNoneMatch === "*") throw new ApiError(412, "VERSION_CONFLICT", "The profile already exists.");
          if (ifMatch === undefined) throw new ApiError(428, "PRECONDITION_REQUIRED", "Updating a profile requires If-Match with its current ETag.");
          if (ifMatch !== etag(existing.version)) throw new ApiError(412, "VERSION_CONFLICT", "The profile changed since you last read it.");
          expected = existing.version;
        }
        const saved = store.putStyleProfile({ accountId: license.accountId, profileId: id, name: body.name, blob: body.blob, now: now() }, expected);
        if (!saved) throw new ApiError(412, "VERSION_CONFLICT", "The profile changed since you last read it.");
        return send(res, existing ? 200 : 201, { profileId: saved.profileId, version: saved.version, etag: etag(saved.version), updatedAt: saved.updatedAt }, { etag: etag(saved.version) });
      }
    }
    throw new ApiError(404, "NOT_FOUND", "Not found.");
  }

  /** Paddle Billing: signed with `Paddle-Signature`, delivered at least once and out of order (plan §5, docs/research/billing-identity-verification.md). */
  async function paddleWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const paddle = deps.paddle;
    if (!paddle) throw new ApiError(404, "NOT_FOUND", "Not found.");
    const raw = await readRawBody(req);
    const header = req.headers["paddle-signature"];
    if (!verifyPaddleSignature(raw, typeof header === "string" ? header : undefined, paddle.webhookSecret, { toleranceSec: paddle.toleranceSec, nowMs: now() })) {
      log({ level: "warn", msg: "paddle webhook rejected", reason: "signature" });
      throw new ApiError(401, "INVALID_SIGNATURE", "The webhook signature is not valid.");
    }
    requireJson(req);
    let event: unknown;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      throw badRequest("The body is not valid JSON.");
    }
    try {
      return send(res, 200, { ok: true, ...applyPaddleEvent({ store, paddle, now, log }, event) });
    } catch (err) {
      if (err instanceof InvalidPaddleEvent) throw badRequest(err.message);
      throw err;
    }
  }

  async function webhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const raw = await readBody(req);
    const header = String(req.headers["x-signature"] ?? "").replace(/^sha256=/i, "").toLowerCase();
    const expected = createHmac("sha256", deps.webhookSecret).update(raw).digest("hex");
    if (!header || !safeEqual(header, expected)) throw new ApiError(401, "INVALID_SIGNATURE", "The webhook signature is not valid.");
    requireJson(req);

    const event = parse(WebhookSchema, raw);
    if (event.type !== "subscription.upsert") return send(res, 200, { ignored: true });
    const data = SubscriptionDataSchema.safeParse(event.data);
    if (!data.success || (!data.data.accountId && !data.data.email)) throw badRequest("data: a valid subscription with accountId or email is required");

    // Resolve the account without creating anything yet.
    const { accountId, email } = data.data;
    let account = accountId ? store.getAccount(accountId) : store.getAccountByEmail(email!.toLowerCase());
    if (accountId && !account) throw badRequest("data.accountId: unknown account");

    // Idempotency: record the event only after validation, so a malformed event the provider later corrects
    // is not swallowed as a duplicate.
    if (!store.recordWebhookEvent(event.id, now())) return send(res, 200, { duplicate: true });
    account ??= createAccount(email!.toLowerCase());

    setSubscription(account.id, data.data);
    return send(res, 200, { ok: true, accountId: account.id });
  }

  function createAccount(email: string) {
    const account = { id: newId("acct", rb), email, createdAt: now() };
    store.createAccount(account);
    return account;
  }

  function setSubscription(accountId: string, data: z.infer<typeof SubscriptionDataSchema>): void {
    store.upsertSubscription({
      accountId,
      plan: data.plan,
      seats: data.seats,
      adapters: data.adapters ?? DEFAULT_ADAPTERS[data.plan],
      status: data.status,
      currentPeriodEnd: data.currentPeriodEnd ? Date.parse(data.currentPeriodEnd) : null,
      updatedAt: now(),
    });
  }

  /** A signed document's bytes, or its signature file when asked for `<name>.sig`; clients re-check with `If-None-Match`. */
  function serveDocument(req: http.IncomingMessage, res: http.ServerResponse, name: string, signature: boolean): void {
    const attempt = limiter.hit(`documents:${clientIp(req)}`, limits.documentsPerIpPerMinute, MINUTE);
    if (!attempt.allowed) throw rateLimited(attempt.retryAfterSec);
    const document = store.getDocument(name);
    if (!document) throw new ApiError(404, "NOT_FOUND", "No such document.");
    const body = signature ? Buffer.from(document.signature) : document.bytes;
    const etag = `"${sha256Hex(body).slice(0, 32)}"`;
    const headers = {
      etag,
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "content-type": signature ? "application/json" : "application/octet-stream",
    };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, "content-length": String(body.length) });
    res.end(body);
  }

  async function admin(req: http.IncomingMessage, res: http.ServerResponse, method: string, path: string): Promise<void> {
    requireAdmin(req);

    // Publishing: the operator signs offline (the signing key never reaches this server) and uploads the result.
    const published = /^\/admin\/v1\/documents\/([^/]+)$/.exec(path);
    if (method === "PUT" && published) {
      const name = published[1]!;
      if (!DOCUMENT_NAME.test(name)) throw badRequest("The document name must be lowercase letters, digits and hyphens, up to 40 characters.");
      requireJson(req);
      const body = parse(PublishSchema, await readBody(req));
      const bytes = Buffer.from(body.bytesBase64, "base64");
      if (bytes.toString("base64") !== body.bytesBase64) throw badRequest("bytesBase64: not valid base64");
      if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES) throw badRequest(`bytesBase64: a document is 1 to ${MAX_DOCUMENT_BYTES} bytes`);
      store.putDocument({ name, bytes, signature: JSON.stringify(body.signature), updatedAt: now() });
      return send(res, 204);
    }

    if (method === "POST" && path === "/admin/v1/accounts") {
      requireJson(req);
      const { email } = parse(z.object({ email: z.string().email().max(254) }).strict(), await readBody(req));
      if (store.getAccountByEmail(email.toLowerCase())) throw new ApiError(409, "EMAIL_EXISTS", "An account with this email already exists.");
      return send(res, 201, { accountId: createAccount(email.toLowerCase()).id });
    }

    if (method === "POST" && path === "/admin/v1/licenses") {
      requireJson(req);
      const body = parse(z.object({ accountId: z.string().max(64), maxDevices: z.number().int().min(1).max(50).optional() }).strict(), await readBody(req));
      if (!store.getAccount(body.accountId)) throw new ApiError(404, "NOT_FOUND", "No such account.");
      const licenseKey = newLicenseKey(rb);
      const license: License = { id: newId("lic", rb), accountId: body.accountId, keyHash: sha256Hex(licenseKey), maxDevices: body.maxDevices ?? 2, createdAt: now(), revokedAt: null };
      store.createLicense(license);
      // The plaintext key is returned exactly once; only its hash is stored.
      return send(res, 201, { licenseId: license.id, licenseKey });
    }

    const account = /^\/admin\/v1\/accounts\/([^/]+)$/.exec(path);
    if (method === "GET" && account) {
      const found = store.getAccount(account[1]!);
      if (!found) throw new ApiError(404, "NOT_FOUND", "No such account.");
      const sub = store.getSubscription(found.id);
      return send(res, 200, {
        account: found,
        subscription: sub ?? null,
        licenses: store.listLicenses(found.id).map((l) => ({
          id: l.id,
          maxDevices: l.maxDevices,
          createdAt: l.createdAt,
          revokedAt: l.revokedAt,
          activations: store.listActivations(l.id).map((a) => ({ id: a.id, deviceName: a.deviceName, createdAt: a.createdAt, lastSeenAt: a.lastSeenAt, revokedAt: a.revokedAt })),
        })),
      });
    }

    const subscription = /^\/admin\/v1\/accounts\/([^/]+)\/subscription$/.exec(path);
    if (method === "PUT" && subscription) {
      requireJson(req);
      const id = subscription[1]!;
      if (!store.getAccount(id)) throw new ApiError(404, "NOT_FOUND", "No such account.");
      const data = parse(SubscriptionDataSchema, await readBody(req));
      setSubscription(id, data);
      return send(res, 204);
    }

    const revoke = /^\/admin\/v1\/activations\/([^/]+)\/revoke$/.exec(path);
    if (method === "POST" && revoke) {
      if (!store.getActivation(revoke[1]!)) throw new ApiError(404, "NOT_FOUND", "No such activation.");
      store.revokeActivation(revoke[1]!, now());
      return send(res, 204);
    }

    // A leaked license key is cut off here: every device activated with it stops refreshing.
    const revokeLicense = /^\/admin\/v1\/licenses\/([^/]+)\/revoke$/.exec(path);
    if (method === "POST" && revokeLicense) {
      if (!store.getLicense(revokeLicense[1]!)) throw new ApiError(404, "NOT_FOUND", "No such license.");
      store.revokeLicense(revokeLicense[1]!, now());
      return send(res, 204);
    }
    // Repairs drift from missed webhooks by listing Paddle's own subscriptions (needs the lister to be configured).
    if (method === "POST" && path === "/admin/v1/billing/paddle/reconcile") {
      const paddle = deps.paddle;
      if (!paddle?.listSubscriptions) throw new ApiError(404, "NOT_FOUND", "Paddle reconciliation is not configured.");
      return send(res, 200, reconcilePaddleSubscriptions({ store, paddle, now, log }, await paddle.listSubscriptions()));
    }

    throw new ApiError(404, "NOT_FOUND", "Not found.");
  }

  return {
    async listen(port = 0, host = "127.0.0.1"): Promise<{ port: number; close(): Promise<void> }> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve());
      });
      return {
        port: (server.address() as AddressInfo).port,
        close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
      };
    },
  };
}

const etag = (version: number) => `"v${version}"`;
const isBase64 = (s: string) => s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);
const decodedLength = (s: string) => Math.floor((s.length * 3) / 4) - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);

const PROBLEM_TITLES: Record<number, string> = {
  400: "Invalid request",
  401: "Unauthorized",
  402: "Payment required",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  412: "Precondition failed",
  413: "Payload too large",
  415: "Unsupported media type",
  422: "Unprocessable content",
  428: "Precondition required",
  429: "Too many requests",
  500: "Internal error",
};

/** RFC 9457 problem details, with the stable machine-readable `code` and a correlation id as extension members. */
function sendProblem(res: http.ServerResponse, status: number, code: string, detail: string, requestId: string, headers: Record<string, string> = {}): void {
  send(
    res,
    status,
    { type: `urn:vivahlens:problem:${code.toLowerCase().replace(/_/g, "-")}`, title: PROBLEM_TITLES[status] ?? "Error", status, detail, code, requestId },
    { "content-type": "application/problem+json", ...headers },
  );
}

function send(res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status, { "cache-control": "no-store", ...headers });
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
