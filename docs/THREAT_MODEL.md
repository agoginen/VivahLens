# VivahLens threat model

What is protected, from whom, by what, and what is left. Written from the code as it stands (2026-11-22, 6th pass), not from intentions: each defence names where it lives and the test that proves it. A defence with no test, or a threat with no defence, says so. This is an engineering document, not a security audit: nothing here has had an independent review or a penetration test.

## What is being protected

| Asset | Why it matters |
|---|---|
| Original photos (RAW and JPEG) | The photographer's work and the clients' faces. Never modified without an undo, never uploaded |
| Previews sent to a model | The only image data that leaves the computer, and only to the provider the photographer chose, with their key |
| Location data in delivered JPEGs | A client's home or venue can be disclosed by a file they share |
| Model keys, the licence refresh token | A refresh token mints new entitlements; a model key spends the photographer's money |
| The jobs database, logs, style profiles | Names of events, clients and photos |
| Signed update and settings documents | Whoever can forge one can disable an editor route, change prices or advertise a malicious build |
| The licensing server's data | Licence keys, devices, usage counts, encrypted style profiles |

## Who the defences are against

1. **Other people's files and input**: a hostile or damaged image, a folder or photo name chosen to break a shell, a hostile response from a model or a server.
2. **Other computers on the network**: anyone who can send a request to the licensing server, or sit between the program and a server.
3. **Other software on the same computer, running as a different user or as the same user's browser**: a web page trying the local review server.
4. **A user who wants to avoid paying**: this is a speed bump, not a wall (see "Not covered").

Not defended against: malware running as the photographer (it can read everything they can), a provider that is itself hostile (it sees previews by design), and a user with a debugger.

## Threats and what answers them

| # | Threat | Defence | Where | Proof |
|---|---|---|---|---|
| 1 | Photos or personal data leave the computer without the photographer knowing | Originals are never uploaded; previews are re-encoded at ≤ 2048 px so EXIF and GPS are gone; every request is counted in a ledger (`vivah privacy`: counts and sizes, no content); per-provider data-handling notices are printed before anything is sent; Gemini refuses to run until a paid-tier project is confirmed; telemetry is off by default and carries counts only; the support bundle replaces folder, photo and job names | `packages/ingest`, `packages/core/src/llm`, `packages/cli/src/{diagnostics,usageReport}.ts` | `diagnostics.test.ts`, `telemetry.test.ts`, gateway and privacy-ledger tests |
| 2 | Location data reaches a client in a delivered JPEG | Removal is on by default and **fails closed**: every GPS pointer in every Exif IFD is deleted, the file is cut down to an allow-list (JFIF, Exif, XMP, colour profile, IPTC), vendor blocks and trailing data are dropped and reported, and an Exif block that cannot be read completely is dropped whole. A file that cannot be finished is deleted, not left behind | `packages/delivery` | 720,000 mutated Exif blocks checked against an independently written lenient reader (no reachable GPS, no exceptions); regression tests for each real bug an independent review found |
| 3 | A model key or refresh token is stolen from disk, from a process listing or from a log | Tokens go to the system secret store (DPAPI, keychain, Secret Service) with a private-file fallback (`icacls`-restricted on Windows); secrets travel on standard input, never on a command line; logs redact by key name and cap long strings; the support bundle strips paths to file names | `packages/core/src/platform/{secrets,privateFile,runner}.ts`, `packages/core/src/observability/redact.ts` | scripted-runner tests assert a secret never appears in any argument list; redaction tests including camel-case names (`inputTokens` is kept, `refreshToken` is not) |
| 4 | A web page or another program uses the local review server | Binds to 127.0.0.1 only; an unguessable one-time token for the page and API; `Host` is checked against DNS rebinding; writes must be `application/json` (a cross-site form cannot send it); the page loads only its own scripts (CSP, no inline script); only a fixed list of asset files is served; body size caps | `packages/review/src/server.ts` | `review.test.ts` (token, host, content type, caps) |
| 5 | Something other than the Lightroom plugin talks to the agent | Loopback only; a token handshake whose file sits in the user's profile with private permissions; a single plugin slot; request timeouts and a 4 MB body cap | `packages/core/src/adapters/pluginBridge.ts`, `packages/lightroom` | bridge and plugin tests, including under a Lua interpreter |
| 6 | A forged or replayed update, price table or adapter switch | Documents are signed with Ed25519 over the exact bytes plus a domain string; keys are pinned by key id (prototype keys such as `constructor` are refused); the document is parsed only after the signature verifies; a freshness window and rollback protection apply; fetches are HTTPS or loopback, capped in size and time; the server stores and serves documents but **holds no signing key** | `packages/core/src/signed`, `packages/cli/src/{signedClient,updates,remoteConfigClient}.ts`, `packages/cloud-api` | 49 tests including tampering, wrong key, wrong domain, expiry, rollback and oversize |
| 7 | Request flooding or memory exhaustion of the licensing server | A 256 KB body cap (413 beyond), rate limits per IP and per refresh token on activation, failed activations, refresh and document downloads, a constant-time length gate on arrays (`boundedArray`: one 256 KB request of empty objects cost zod 3 about 133 MB before it), RFC 9457 errors that reveal no internals | `packages/cloud-api/src/api.ts`, `packages/core/src/boundedArray.ts` | `api.test.ts`, `boundedArray.test.ts` (no element is parsed once the length is over) |
| 8 | A forged billing event grants or removes a subscription | The HMAC is verified over the raw body before anything is parsed; events are idempotent by id and validated before being recorded | `packages/cloud-api/src/billing` | webhook tests. **The field formats come from Paddle's documentation and have not been exercised against Paddle** |
| 9 | Licence keys or tokens stolen from the server's database | Only SHA-256 hashes of keys and refresh tokens are stored; keys carry 100 random bits; a per-licence device cap; entitlements are short-lived (7 days) | `packages/cloud-api` | `store.test.ts`, `api.test.ts` |
| 10 | A hostile or corrupt image harms the agent | All decoding is in plain JavaScript (no native decoder to exploit), bounds-checked, in worker threads with memory limits and crash isolation: a decoder that dies fails that photo with `ASSET_UNREADABLE` and is replaced | `packages/ingest` | `decodePool.test.ts` (dying and runaway decoders) |
| 11 | A hostile photo, folder or job name becomes a command, an option or markup | No shell is ever used; names reach notifications as data (JSON on standard input on Windows, arguments after `--` elsewhere, with a leading dash guarded and markup escaped); names are never part of a script | `packages/core/src/platform/notify.ts` | a property test over hostile strings for all three platforms; the Windows route run for real |
| 12 | A model returns something that does harm | Its output is only ever a recipe, validated against a schema with numeric ranges, and repaired or rejected; it is never executed, and sliders are clamped | `packages/core/src/recipe`, `packages/core/src/llm` | schema and gateway tests |
| 13 | A lapsed or disputed subscription holds the photographer's work hostage | It cannot: after the offline grace, or when the server says the subscription lapsed, **only editing pauses**; export, deliver, undo and review keep working | `packages/core/src/licensing/access.ts` | `access.test.ts`, `entitlementAccess.test.ts`, review-server tests |
| 14 | Edits damage or lose the originals | Sidecars are backed up before being changed and every edit is in an undo log (`vivah undo`); jobs are resumable (a real `kill -9` loses no finished work); Lightroom's plugin folder is replaced by copy and swap | `packages/core/src/pipeline` | `resumability.test.ts`, undo and adapter tests |
| 15 | A malicious dependency | Two runtime dependencies (`jpeg-js`, `zod`); a licence gate; a bill of materials computed from the production closure; build tools pinned (`esbuild`, `postject`); the single executable bundles exactly what the bill lists | `scripts/{check-licenses,sbom,build-sea}.mjs` | `sbom.test.ts`, `sea.test.ts` (what is bundled is a subset of what is listed) |

## Not covered, and known weak points

- **Client-side enforcement is a speed bump.** The licence is verified in the user's own copy, so a determined user can patch it. The server side (device caps, short-lived tokens, rate limits) and the export-only degrade are the real controls, and the trial cap is enforced from a server-signed limit but a patched client ignores it.
- **No process sandbox for decoding.** Memory limits and crash isolation exist; Node's `--permission` model (researched, not wired in) would add a filesystem boundary.
- **Location can survive in** a camera's proprietary MakerNote and in place names typed into IPTC or XMP fields (city, sublocation). The delivery notes say so.
- **Same-user malware**: anything that runs as the photographer can read the jobs database, the logs and the secret store's entries as they can. No defence is claimed.
- **The review URL carries the token** and is printed in the terminal and passed to the browser; shoulder-surfing or a shared terminal log exposes it for the session.
- **Unsigned executables.** The Windows build is unsigned (SmartScreen will warn) and the macOS build would be ad-hoc signed only. Signing and notarization need certificates that are not in this repository.
- **Dependency advisories.** `npm audit` flags `zod` (mitigated at every external boundary; the fix is zod 4, not yet adopted) and several test tools (vitest, vite, tinypool, a nested esbuild) that are not part of anything shipped.
- **Never exercised:** the Paddle webhook against Paddle, anything on macOS or Linux, the notification routes on those systems, the CI and release workflows on GitHub.
- **Not done:** a penetration test, an independent code review of the licensing server, a bug-bounty channel, a privacy review by counsel, a processor agreement for the optional hosted pieces. These are launch-gate items in the plan (§7j, §7k), not engineering tasks.

## Reporting

There is no disclosure address yet. Choosing one is part of the launch checklist.
