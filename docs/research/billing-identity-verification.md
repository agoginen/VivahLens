# Billing & identity verification (round 2)

Condensed from a research pass on **2026-11-22** (primary sources only: vendor docs, IETF/RFC text, OWASP/NIST, EU Official Journal). Facts marked **UNVERIFIED** were not stated in a source that could be read. Source tags map to the list at the end. This note drives `packages/cloud-api` (billing adapter, accounts, device-code login, idempotency, OpenAPI, data-subject requests).

## Five findings that change the plan

1. **Lemon Squeezy is winding down** `[L1][L2]`: new store sign-ups closed 2026-11-16 and it stops processing payments on **2027-03-31** ("extensions will not be offered"). Do not build on its webhooks or licence API.
2. Its successor, **Stripe Managed Payments**, lists no India business location and "doesn't deliver files, license keys, or download links" `[L2][L5]`. Stripe accounts are invite-only in India `[L5]`.
3. **Paddle Billing has no licence keys** `[P8]`: product delivery and licence generation are "yours to rebuild". Licence tokens stay in-house (already the design).
4. `draft-ietf-httpapi-idempotency-key-header` is at revision **-09** (2026-11-21), still a draft `[I1]`.
5. Node's built-in `crypto.argon2` exists only from **v24.7.0**; the repo supports Node ≥ 22.13, so use **scrypt** (OWASP-acceptable) unless the engine floor is raised `[W2]`.

Consequence: for an India-based seller the only verifiable merchant-of-record route found is **Paddle Billing** (payout, tax and onboarding approval for India: UNVERIFIED, confirm during onboarding).

## 1. Paddle Billing webhooks

- Header `Paddle-Signature: ts=<unix seconds>;h1=<hex>` `[P1][P7]`. More than one `h1` during secret rotation: accept the event if **any** matches.
- Signed string is `<ts>:<raw request body>`; HMAC-SHA256 keyed with the notification destination's secret (`pdl_ntfset_…`); hex digest; constant-time compare. Parse the body only after verifying; never re-serialise.
- Tolerance: Paddle's SDKs reject when `|now − ts|` > **5 s in both directions**. Whether each retry is re-signed with a fresh `ts` is UNVERIFIED, so keep the tolerance configurable and log rejections.
- Envelope `[P2][P3]`: `event_id` (`evt_…`), `event_type`, `occurred_at`, `notification_id`, `data`. **At-least-once** delivery; reply `200` within **5 s**, do work after. Live retries: up to 60 attempts over ~2 days. **No ordering guarantee**: compare `occurred_at` with what is stored before applying. Dedupe on `event_id`.
- Subscription events: `subscription.created / trialing / activated / updated / past_due / paused / resumed / canceled`. Transactions: `transaction.paid / completed / payment_failed / past_due …`. **Refunds, credits and chargebacks are `adjustment.created` / `adjustment.updated`** (there is no `transaction.refunded`); adjustment `action` ∈ credit, refund, chargeback, chargeback_reverse, chargeback_warning, chargeback_warning_reverse, credit_reverse; `status` ∈ pending_approval, approved, rejected, reversed `[P4]`.
- Entitlement fields `[P4][P5]`: `status` (`active, trialing, past_due, paused, canceled`), `current_billing_period.ends_at` (**null once paused or canceled**, so store our own `access_until`), `scheduled_change {action, effective_at}` (a pending cancel keeps `status: active` until `effective_at`), `next_billed_at`, `customer_id`, `items[].price.id`. Paddle's access table: trialing/active full; past_due full with a banner; paused none or read-only; canceled none unless `scheduled_change.effective_at` is in the future.
- Account mapping: pass `{"vl_account_id": "<id>"}` as checkout `customData`; it is copied to the subscription and arrives in `data.custom_data` `[P6]`. Never map on email alone.
- Paddle recommends a periodic reconciliation job that lists subscriptions by API to repair drift `[P5]`.
- Cardless trials (price with `requires_payment_method: false`, transaction created by API) exist as an early-access feature `[P9]`; without a payment method at trial end Paddle cancels. Confirm availability before relying on it.
- Source IPs and sandbox behaviour are listed in `[P3]`.

## 2. RFC 8628 device authorization grant `[D1][D2]`

- Request: `POST` form-encoded with `client_id`; start only when the user asks. Response `200` JSON with `device_code`, `user_code`, `verification_uri`, optional `verification_uri_complete`, `expires_in` (lifetime of both codes), `interval` (minimum poll gap, default **5**).
- Token request: `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, `client_id`. Errors are HTTP 400 with `{"error": …}`: `authorization_pending` (keep polling), `slow_down` (**add 5 s to the interval for this and all later requests**), `access_denied` (stop), `expired_token` (session over), anything else (stop). Responses carry `Cache-Control: no-store`.
- `user_code`: charset `BCDFGHJKLMNPQRSTVWXZ` (no vowels, no look-alikes), 8 characters shown as `WDJB-MJHT`, normalised by stripping dashes and upper-casing. About 34.6 bits, so **rate-limit attempts** (the RFC's worked example allows 5 attempts) and keep the lifetime short (≤ 600 s, from ASVS 6.5.5; the RFC recommends no number).
- `device_code` needs very high entropy; store only a hash; make tokens single-use after approval; tell the user they are authorising a device and show its name (§5.4).

## 3. TOTP and recovery codes `[T1]–[T6]`

- SHA-1, 6 digits, 30 s step, T0 = 0, 8-byte counter (maximum authenticator interoperability; the key-URI `algorithm`/`period` parameters are ignored by some apps and the wiki is archived).
- Accept the **current and one previous** step only; persist the **last accepted step per account and update it atomically**; reject it and any earlier step (replay). Throttle per account, not per IP; ≤ 100 consecutive failures per authenticator (NIST) with growing waits.
- Secret ≥ 128 bits (160 recommended), CSPRNG, encrypted at rest, never returned after enrolment. `otpauth://totp/Issuer:account?secret=<base32, no padding>&issuer=Issuer&algorithm=SHA1&digits=6&period=30`.
- Recovery codes: single use, generated at enrolment, stored hashed; if < 112 bits of entropy, hash with a salted password hash (ASVS 6.5.2). Count and format are not specified by OWASP (design choice: 8–10 codes of ≥ 50 random bits, shown once).
- RFC 6238 appendix B check: SHA-1, t = 59, 8 digits → `94287082`.

## 4. Passwords, lockout, sessions `[W1]–[W7]`

- OWASP scrypt minimum: **N = 2^17, r = 8, p = 1** (or N = 2^16/p = 2, 2^15/p = 3, 2^14/p = 5, 2^13/p = 10). Node's defaults (N = 16384) are weaker than every row and its default `maxmem` (32 MiB) **throws** for these settings: OpenSSL needs `maxmem ≥ 128·r·(N + 2 + p)` = **134,220,800** bytes for the first row, so pass e.g. 256 MiB. Argon2id minimum m = 19456 KiB, t = 2, p = 1 (Node ≥ 24.7 only). Random per-user salt ≥ 16 bytes; store the parameters with the hash and **re-hash at next login** when they are raised.
- Lockout counter belongs to the **account, not the IP**; uniform responses and similar timing whether the account exists, the password was wrong, or it is locked; do not let lockout become a denial of service (the reset path stays open).
- Session ids ≥ 64 bits of entropy. **Refresh tokens for public clients: rotate on every use, keep the chain, and if an already-used token is presented revoke the whole family** (RFC 9700 §4.14.2); give refresh tokens an **absolute expiry** even with sliding use (ASVS 10.4.8); make them revocable from a UI (10.4.9); keep them in the OS keychain, not in WebView storage.

## 5. Idempotency-Key (draft -09) `[I1][I2]`

- Header value is an RFC 9651 **String**, i.e. **quoted** on the wire (`Idempotency-Key: "8e03978e-…"`); UUID recommended; parsers must handle ≥ 1024 characters. Be liberal and also accept an unquoted value.
- Server behaviour: first use runs normally; retry of a completed request answers consistently with the original (store and replay status and body); **concurrent duplicate → 409** `problem+json`; **same key, different payload → 422**; **missing key where required → 400**. Optional payload fingerprint (hash of method, path and canonical body).
- Security: composite lookup key that includes the authenticated account, validate the key before any cache lookup, use high-entropy keys. Retention window and whether 5xx results are cached are not specified: choose and document.

## 6. OpenAPI 3.1 `[O1][O2]`

- Needs `openapi` and `info` (`title`, `version`) and at least one of `paths`, `components` or `webhooks`. Response keys are quoted (`"200"`); every response has a `description`. Bearer auth is `type: http, scheme: bearer` (never a header parameter: `Authorization` is ignored there); `security: []` on an operation removes auth (device authorization and token endpoints). Document the billing webhook under `webhooks`.
- Errors: RFC 9457 `application/problem+json` (`type`, `title`, `status`, `detail`, `instance`) with extension members `code` (stable machine-readable) and `requestId`.

## 7. Data-subject requests (GDPR) `[G1]`

- Art. 12(3): answer within **one month**, extendable by **two further months** for complexity, with the extension and reasons notified inside the first month; Art. 12(6): may ask for more information if identity is doubtful; free of charge unless manifestly unfounded or excessive.
- Art. 17: erasure "without undue delay"; exceptions include legal obligations (billing and invoice records are kept) and legal claims. Art. 15(3)/20: a copy in a structured, commonly used, machine-readable form. Art. 28(3)(e),(g): as a **processor** (photographers' end-client data) VivahLens assists the controller and deletes or returns data at the end of the service; it does not answer those requests itself.
- Design: store `received_at`, `due_at`, `extended_until`, `status` per request.

## Still UNVERIFIED (re-check before committing)

Paddle re-signing of retries; whether any 2xx other than 200 counts as delivered; `subscription.imported` and `transaction.revised` semantics; Paddle payout/tax/onboarding for India and the general-availability date of cardless trials; Lemon Squeezy details (it is closing); RFC 8628 `expires_in` (600 s is analysis); current authenticator-app behaviour for `algorithm`/`period`/`digits`; Idempotency-Key retention and 5xx caching; how GDPR "one month" is counted; the OpenAPI sample was not run through a full OAS 3.1 validator.

## Sources (retrieved 2026-11-22)

- `[P1]` developer.paddle.com/webhooks/about/signature-verification · `[P2]` …/webhooks/about/how-webhooks-work · `[P3]` …/webhooks/about/respond-to-webhooks · `[P4]` event pages under developer.paddle.com/webhooks/ · `[P5]` …/build/subscriptions/provision-access-webhooks · `[P6]` …/build/transactions/custom-data · `[P7]` github.com/PaddleHQ/paddle-node-sdk (webhooks-validator.ts) · `[P8]` developer.paddle.com/migrate/paddle-classic/plan and …/learn/feature-comparison · `[P9]` …/build/trials/cardless-trials · `[P10]` paddle.com/help/start/intro-to-paddle/which-countries-are-supported-by-paddle
- `[L1]` lemonsqueezy.com/blog/saying-goodbye-to-lemon-squeezy · `[L2]` docs.lemonsqueezy.com/migration · `[L5]` docs.stripe.com/payments/managed-payments/eligibility and support.stripe.com/questions/stripe-accounts-are-invite-only-in-india
- `[D1]` rfc-editor.org/rfc/rfc8628 · `[D2]` rfc-editor.org/rfc/rfc6749 §5
- `[T1]` rfc6238 · `[T2]` rfc4226 · `[T3]` github.com/google/google-authenticator/wiki/Key-Uri-Format · `[T4]` OWASP Multifactor Authentication Cheat Sheet · `[T5]` OWASP ASVS 5.0 V6 · `[T6]` NIST SP 800-63B-4 §3.2.2
- `[W1]` OWASP Password Storage Cheat Sheet · `[W2]` nodejs.org/api/crypto.html · `[W4]` OWASP Authentication Cheat Sheet · `[W5]` OWASP Session Management Cheat Sheet · `[W6]` OWASP ASVS 5.0 V7 and V10 · `[W7]` rfc9700 §4.14
- `[I1]` datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/ · `[I2]` rfc9651
- `[O1]` spec.openapis.org/oas/v3.1.2.html · `[O2]` rfc9457
- `[G1]` Regulation (EU) 2016/679, OJ L 119 (read from publications.europa.eu/resource/celex/32016R0679)
