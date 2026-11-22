# Platform, Release & Security Verification #2 for VivahLens

**Retrieval date for all sources: 2026-11-22** (web pages and source files fetched with HTTP clients / `git ls-remote`, not a browser).
**Method:** primary sources only: the owning project's docs, RFCs/specs, and **source code pinned to a commit or tag** so line numbers stay valid. Behaviour I executed here is tagged **[local run]** (Node v24.19.0, npm 11.17.0, Windows PowerShell 5.1.26100, Windows 10.0.26200): it is evidence of behaviour, not documentation. Anything I could not confirm from a primary source is **UNVERIFIED** (with what I tried). *Analysis (not from a source)* marks design proposals. No file other than this one was modified.
**Does not repeat** [platform-and-market-verification.md](platform-and-market-verification.md) §4 (updater exists and cannot be disabled, `signer generate` basics, key loss, OS code-signing, WebView, `keyring`). It adds what that note lacks: the exact manifest/signature contracts, and nine other topics.
**Node scope.** On 2026-11-22 `nodejs.org/dist/index.json` lists v24.22.3 (LTS "Krypton"), v22.23.5 (LTS "Jod") and v26.13.1 (LTS "Lithium"); the repo declares `engines.node >=22.13` (`package.json`), this machine runs v24.19.0. Doc statements below are from the tags v24.22.3 / v22.23.5 unless a line says otherwise.

### Citation shorthand (every `[TOKEN path#Lx-Ly]` expands to the prefix below + `path` + `#Lx-Ly`)
| Token | Prefix (all pinned) |
|---|---|
| `TPU` | `https://github.com/tauri-apps/plugins-workspace/blob/24e6451b11fbd3378eccf4824552053d8862c66b/plugins/updater/src/` (branch `v2`; line numbers re-verified at this SHA) |
| `TCLI` | `https://github.com/tauri-apps/tauri/blob/ff7cd8d863061aaa1c5932062b071db6b17af36e/crates/tauri-cli/src/` (branch `dev`) |
| `MSV` | `https://github.com/jedisct1/rust-minisign-verify/blob/145b9950330ca903f20372ee6e5be6d46ed60025/src/lib.rs` |
| `APL` | `https://github.com/apple-oss-distributions/Security/blob/db15acbe6a7f257a859ad9a3bb86097bfe0679d9/` (Apple's open-source `security` tool) |
| `LSEC` / `LNOT` | `https://gitlab.gnome.org/GNOME/libsecret/-/blob/7ab0b42f5581e5793d6fd32df3f0eea9a20f41b9/` / `https://gitlab.gnome.org/GNOME/libnotify/-/blob/9b53a46b0307fe3a7ddd2545de1e395ee2f94d18/` |
| `MINIO` | `https://github.com/minio/minio/blob/7aac2a2c5b7c882e68c1ce017d8256be2feea27f/cmd/` |
| `NPM` | `https://github.com/npm/cli/blob/787f1520fa412e91a5792468f1c7f25b166867a6/lib/` (branch `latest`) |
| `SPDXA` | `https://github.com/spdx/spdx-spec/blob/a1cacf2de9e6b4768ec96cda3a25bd9bef3a86f7/docs/annexes/spdx-license-expressions.md` |
| `CDX` | `https://github.com/CycloneDX/specification/blob/5fee6af48d43c751dc6a5b31138f06af2b10bac5/schema/` |
| `SSH2` | `https://github.com/mscdex/ssh2/blob/844f1edfc41589737671f96a4f4e76afdf46abd4/` (tag `v1.17.0`); `SSH2m` = same repo at `master` HEAD `a3a39d795a8d7ff43d5f33aafadccfc03466d044` |
| `N24` / `N22` / `N26` | `https://github.com/nodejs/node/blob/v24.22.3/doc/api/` / `…/v22.23.5/doc/api/` / `…/v26.13.1/doc/api/` (the Markdown source of https://nodejs.org/docs/latest-v24.x/api/ etc.) |
| `REPO` | files in this repository |

---

## 1. Update manifests: Tauri v2 updater, minisign, Sparkle, and a design for our own signed channel manifest

### Answer

**1.1 What the Tauri v2 updater actually consumes** (docs + the plugin source that implements them)

| Item | Fact | Evidence |
|---|---|---|
| Config | `plugins.updater.pubkey` (key **content**, "cannot be a file path"), `endpoints` (array; TLS enforced unless `dangerousInsecureTransportProtocol`), `bundle.createUpdaterArtifacts: true` | Tauri docs "Tauri Configuration"; `[TPU config.rs#L198-L212]` rejects non-https endpoints |
| URL variables | Docs: `{{current_version}}`, `{{target}}` (`linux`/`windows`/`darwin`), `{{arch}}` (`x86_64`/`i686`/`aarch64`/`armv7`). The source also substitutes `{{bundle_type}}` and knows `riscv64` (not in the docs) | `[TPU updater.rs#L546-L573]`, `[TPU updater.rs#L1756-L1779]` |
| Endpoint fall-through | Docs: "only continue to the next url if a non-2XX status code is returned". Code: error/non-success → log and try next; **204 returns `Ok(None)` at once**; a 2xx that fails to deserialize is kept as `last_error` and returned if no later endpoint yields a release | `[TPU updater.rs#L614-L658]` |
| **Static JSON** | Required: `version`, `platforms.<target>.url`, `platforms.<target>.signature`. Optional: `notes`, `pub_date` (RFC 3339). Docs warn the **whole file is validated before the version check**, so every listed platform entry must be complete | Tauri docs "Static JSON File" |
| **Dynamic server** | Respond **`204 No Content`** when no update; else **`200`** + JSON `{version, pub_date?, url, signature, notes?}` (required: `url`, `version`, `signature`) | Tauri docs "Dynamic Update Server"; `[TPU updater.rs#L616-L621]` |
| Parsing details | `version` may also be spelled `name`; a leading `v` is stripped; must be SemVer; `pub_date` parsed with RFC 3339; presence of `platforms` selects static mode, else `url`+`signature` are mandatory | `[TPU updater.rs#L1823-L1868]`, `[TPU updater.rs#L1883-L1890]` |
| Target keys | A custom `target` string is matched verbatim against `platforms` keys. Otherwise the plugin tries `{os}-{arch}-{installer}` then `{os}-{arch}`; installers: `appimage`, `deb`, `rpm`, `app`, `msi`, `nsis`; OS names `linux`/`darwin`/`windows` | `[TPU updater.rs#L748-L773]`, `[TPU updater.rs#L70-L75]`, `[TPU updater.rs#L1756-L1767]` |
| Version rule | Default: install only if `release.version > current`. Roll-back: Rust `version_comparator(|current, update| update.version != current)` or config `allowDowngrades` ("must be different"; ignored when a custom comparator is set) | Tauri docs "Allowing downgrades"; `[TPU updater.rs#L712-L715]`; `[TPU config.rs#L136-L148]` |
| Channels | The docs' own example builds the endpoint at runtime from a `channel` variable (`https://{channel}.myserver.com/{{target}}-{{arch}}/{{current_version}}`), i.e. channels are a server/URL convention, not a manifest field | Tauri docs "Runtime Configuration → Endpoints" |
| Key rotation hook | `Builder::pubkey()` / `updater_builder().pubkey()` set the verification key at runtime "useful to implement a key rotation logic" | Tauri docs "Public key" |

**1.2 Signature: what is signed, how it is verified**
- `signature` in the manifest is **the content of the generated `.sig` file** ("A path or URL does not work!"). That file is `base64(<4-line minisign signature text>)`: `[TCLI helpers/updater_signature.rs#L184-L186]`. `pubkey` is likewise `base64(<2-line minisign public key text>)`: `[TCLI helpers/updater_signature.rs#L51-L61]`.
- Verification (`verify_signature`): base64-decode both, `PublicKey::decode`, `Signature::decode`, then `public_key.verify(data, &signature, true)`; the `true` is `allow_legacy`, so unhashed `Ed` signatures are also accepted: `[TPU updater.rs#L1893-L1917]`, `[MSV#L351-L371]`.
- **The manifest itself is not signed**; only the downloaded artifact is. The plugin's own config comments say so and explain the attack: a tampered response can pair a new `version` with the URL+signature of an older, validly signed release (forced downgrade): `[TPU config.rs#L117-L134]`. The mitigation is opt-in (`requireSignedVersion`, default `false`): the signature's **trusted comment** carries `version:<semver>` (tab-separated `timestamp:…\tfile:…\tversion:…`), and the updater rejects a mismatch: `[TPU updater.rs#L1925-L1967]`. The CLI writes it when signing with `tauri signer sign --app-version <v>` and "`tauri build` sets this automatically": `[TCLI signer/sign.rs#L38-L47]`, `[TCLI helpers/updater_signature.rs#L161-L171]`. Turning the flag on rejects older signatures that carry no version (`MissingSignedVersion`): `[TPU config.rs#L126-L129]`. Enabling `allowDowngrades` "removes the only guard" against re-installing an old signed build: `[TPU config.rs#L140-L143]`.

**1.3 `tauri signer generate` / `sign` workflow** (flags and files)
- `npm run tauri signer generate -- -w ~/.tauri/myapp.key` (docs "Signing updates"). Flags: `-p/--password`, `-w/--write-keys <path>`, `-f/--force`, `--ci` (env `CI`; with `--ci` and no password the key gets an **empty password** and a warning): `[TCLI signer/generate.rs#L14-L37]`.
- Writes `<path>` (private) and `<path>.pub`; both are `base64(minisign key-box text)`; refuses to overwrite without `--force`; on Unix the private file is created `0600` and also `chmod 0600`'d if it pre-existed: `[TCLI helpers/updater_signature.rs#L26-L44]`, `[TCLI helpers/updater_signature.rs#L79-L122]`.
- Env vars: `TAURI_SIGNING_PRIVATE_KEY` (string or path for `build`/`bundle`; **literal string** for `signer sign`), `TAURI_SIGNING_PRIVATE_KEY_PATH` (for `signer sign`), `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; `.env` files do not work (docs): `[TCLI signer/generate.rs#L62-L71]`. With no password and no TTY the CLI assumes an empty password: `[TCLI helpers/updater_signature.rs#L196-L219]`.
- Signing an artifact: `tauri signer sign [-k <key>|-f <file>] [-p <pw>] [--app-version <v>] <file>` prints the base64 signature to paste into `signature`: `[TCLI signer/sign.rs#L16-L50]`, `[TCLI signer/sign.rs#L113-L117]`.

**1.4 minisign file format (official spec) and what Node `crypto` can do with it**

| Piece | Definition | Evidence |
|---|---|---|
| Signature file | line 1 `untrusted comment: …`; line 2 `base64(alg(2) ‖ key_id(8) ‖ sig(64))` = 74 bytes; line 3 `trusted comment: …`; line 4 `base64(global_sig(64))` | minisign docs "Signature format"; `[MSV#L232-L259]` |
| `alg` | `Ed` (0x45 0x64) = legacy, signs the file bytes; **`ED` (0x45 0x44) = prehashed**, signs **BLAKE2b-512(file)**; "New implementations must use the hashed signature format" | minisign docs; `[MSV#L255-L259]`, `[MSV#L361-L364]` |
| Global signature | `ed25519(sig ‖ trusted_comment_bytes)`; the trusted comment is *covered*, the untrusted one is not ("can be freely modified") | minisign docs "Trusted comments"; `[MSV#L334-L346]` |
| Public key file | line 1 `untrusted comment: …`; line 2 `base64(alg(2) ‖ key_id(8) ‖ ed25519_pub(32))` = 42 bytes | minisign docs "Public key format"; `[MSV#L289-L321]` |
| Trusted-comment use | Docs recommend putting "timestamps, resource identifiers, or version numbers" there "to prevent downgrade attacks" | minisign docs "Trusted comments" |

- **Ed25519 primitive** = RFC 8032 pure Ed25519 (§5.1; verify §5.1.7 splits the 64-byte signature into two 32-octet halves; test vectors §7.1): https://www.rfc-editor.org/rfc/rfc8032 (`rfc8032.txt` lines 745-760 and 1295-1301). SPKI wrapping for X.509-style APIs: OID `id-Ed25519 = 1.3.101.112`, "parameters MUST be absent": RFC 8410 (`rfc8410.txt` lines 193-194, 210).
- **Node `crypto` mapping** (v24.22.3 and v22.23.5 docs): `crypto.verify(algorithm, data, key, signature)`; for Ed25519 `algorithm` "is required to be `null` or `undefined`": `[N24 crypto.md#L6773-L6774]`, `[N24 crypto.md#L6719]`, `[N22 crypto.md#L5497]`. Key import: DER **SPKI** (`createPublicKey({key, format:'der', type:'spki'})`), **JWK** (since v15.12.0: `[N24 crypto.md#L4298-L4300]`), or `format:'raw-public'` with `asymmetricKeyType:'ed25519'` **only from v24.15.0** (`[N24 crypto.md#L4292-L4294]`, `[N24 crypto.md#L4319-L4325]`; not in the v22.23.5 doc). Prefer SPKI/JWK for Node 22.
- **[local run, Node v24.19.0]** the SPKI header for a raw Ed25519 key is the 12 bytes `302a300506032b6570032100`; `getHashes()` contains `blake2b512`. A 25-line verifier (below) **verified both public minisign vectors** and rejected tampered data:
  - Vector A (minisign-verify README, payload bytes `test`): pub `RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3`, signature `RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=`, trusted comment `timestamp:1633700835\tfile:test\tprehashed`, global sig `wLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==`: `[MSV#L14-L39]`.
  - Vector B (Tauri CLI output, payload `test`, signed with `--app-version 2.0.0`): pub `RWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe`, sig `RUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=`, trusted comment `timestamp:1791649051\tfile:payload\tversion:2.0.0`, global sig `DDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA==`: `[TPU updater.rs#L2117-L2123]`.

```js
// minisign verification with node:crypto only (tested on Node 24.19.0)
import { createHash, createPublicKey, verify } from 'node:crypto';
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');           // RFC 8410 id-Ed25519 header
export function verifyMinisign(pubB64, sigText, data) {               // pubB64 = line 2 of the .pub file
  const pub = Buffer.from(pubB64, 'base64');                          // 'Ed' | keyId(8) | key(32)  = 42 bytes
  const [, b64sig, trustedLine, b64global] = sigText.split(/\r?\n/);
  const s = Buffer.from(b64sig, 'base64');                            // alg(2) | keyId(8) | sig(64) = 74 bytes
  if (pub.length !== 42 || s.length !== 74 || !trustedLine.startsWith('trusted comment: ')) throw new Error('bad encoding');
  if (!pub.subarray(2, 10).equals(s.subarray(2, 10))) throw new Error('key id mismatch');
  const alg = s.subarray(0, 2).toString('latin1');                    // 'ED' prehashed (required) | 'Ed' legacy (reject)
  if (alg !== 'ED') throw new Error('legacy/unknown algorithm');
  const key = createPublicKey({ key: Buffer.concat([SPKI, pub.subarray(10)]), format: 'der', type: 'spki' });
  const sig = s.subarray(10), trusted = trustedLine.slice('trusted comment: '.length);
  const ok1 = verify(null, createHash('blake2b512').update(data).digest(), key, sig);
  const ok2 = verify(null, Buffer.concat([sig, Buffer.from(trusted)]), key, Buffer.from(b64global, 'base64'));
  if (!ok1 || !ok2) throw new Error('bad signature');
  return trusted;                                                     // e.g. 'timestamp:…\tfile:…\tversion:2.0.0' - only trust AFTER verify
}
```

**1.5 Sparkle (comparison; macOS-only updater)**
- Keys: `./bin/generate_keys` creates an **EdDSA (ed25519)** key pair once, stores the private key in the login Keychain and prints the base64 public key for the app's `SUPublicEDKey`; `-x`/`-f` export/import keys. `./bin/sign_update <archive>` prints `sparkle:edSignature="<base64>" length="<bytes>"`; `generate_appcast <folder>` signs automatically. The signature is over the **archive**; the feed can additionally be signed when the app sets `SURequireSignedFeed` (then `sign_update` is also run on the appcast and on release-notes files); `SURequireFeedBundleIdentifier` (Sparkle 2.11 beta) adds a signed bundle-id check. Sparkle's docs also advise keeping signing keys off the web-server host. (Sparkle docs: "Publishing an update", "Documentation" main page, "Customization → security settings".)
- Channels: an `<item>` is on the default channel unless it has `<sparkle:channel>beta</sparkle:channel>`; an updater only sees non-default channels it is allowed to (`allowedChannelsForUpdater:`) and "**cannot exclude itself from the default channel**"; channels are for branching off updates until they return to default, "not … parallel releases".
- Phased rollout: `<pubDate>` + `<sparkle:phasedRolloutInterval>` (seconds); "Sparkle hardcodes the number of groups to 7" (interval 86400 ⇒ full rollout in 7 days); the group id is random, stored in user defaults (`SUUpdateGroupIdentifier`), "not transmitted to servers"; **not applied** to critical updates or manual "Check for Updates".
- Other per-item gates: `sparkle:minimumSystemVersion`/`maximumSystemVersion`, `sparkle:hardwareRequirements`, `sparkle:minimumAutoupdateVersion` (major upgrades), `sparkle:criticalUpdate`, `sparkle:ignoreSkippedUpgradesBelowVersion`.

**1.6 TUF (the standard vocabulary for what a manifest must defend against)**: TUF spec v1.0.37 (last modified 8 Oct 2026) lists *rollback attacks* ("cannot trick clients into installing software that is older than that which the client previously knew to be available") and *indefinite freeze attacks* ("cannot respond … with the same, outdated metadata without the client being aware"); the client MUST reject metadata whose version is lower than the trusted one (equal ⇒ discard, not an error) and metadata whose expiration is not later than the update start time (spec §5.4 "Update the timestamp role" plus the attack list in the introduction: https://theupdateframework.github.io/specification/latest/).

**1.7 Design: our own signed manifest (channels, staged rollout, rollback), verifiable offline with an Ed25519 key**
*Analysis (not from a source), built only from the primitives verified above; the verifier and bucketing below were exercised [local run].*

- **Keep two layers.** (1) Artifact signatures stay as Tauri/minisign (`ED`, binds `version:` in the trusted comment; set `requireSignedVersion: true`; sign with `--app-version`). (2) A **separate signed manifest** that Tauri does not provide: the agent/app verifies it *before* deciding to call the updater, then points the updater at the single verified release (e.g. via a local endpoint or `updater_builder().endpoints(...)` + `target`). This closes the gap documented in `[TPU config.rs#L117-L134]`.
- **Wire format.** One file per channel, `/<channel>/manifest.json`, UTF-8, signed **as exact bytes** (no JSON canonicalisation needed; if embedding the signature inside JSON is ever required, use RFC 8785 JCS), plus detached `manifest.json.sig` = `{"kid","alg":"Ed25519","sig":"<base64 64 B>"}`. Signed message = `"vivahlens-release-manifest-v1\n" ‖ manifestBytes` (domain separation so the key can't be replayed for other artefacts). Offline trust root = public key(s) pinned in the app (`kid → 32 B`); rotation = ship an app version that pins the new `kid` while the manifest is signed by the old one, then switch (cf. runtime `pubkey()`).
- **Fields.** `schema`, `channel` (`alpha|beta|stable`), `sequence` (monotonic integer), `issuedAt`, `expiresAt`, `releases[]` each `{version, status: active|withdrawn, rolloutBp (0-10000), minFromVersion?, notes, artifacts{ "<os>-<arch>-<installer>": {url, sha256, size, tauriSignature} } }`, optional `rollback: {from:[versions], to: version}`.
- **Client algorithm** (verified): (1) verify signature over bytes with a pinned key; (2) only then `JSON.parse`; (3) `channel` equals the channel the manifest was requested for; a client never switches channels by itself, and an alpha/beta client also evaluates the `stable` manifest and takes the highest eligible version (mirrors Sparkle's "an updater cannot exclude itself from the default channel"); (4) `expiresAt` > now (freeze) else keep the last good state and show "update info stale"; (5) `sequence` ≥ stored `sequence`, and if equal the bytes' SHA-256 must equal the stored one (rollback); persist both; (6) pick the highest `active` release whose `bucket(installId, version) < rolloutBp`; (7) pass to Tauri, which checks the artifact signature and (with `requireSignedVersion`) the signed version.
- **Staged rollout %**: `bucket = uint32_be(SHA-256(installId ‖ "\n" ‖ version)[0..4]) mod 10000`, eligible iff `bucket < rolloutBp`. Deterministic per install+version and **monotonic** (raising 2500→5000→10000 never un-selects anyone); measured share at 2500 bp over 100,000 random ids = 25.13 % [local run]. Sparkle's mechanism is different by its docs: 7 fixed time-based groups, so it cannot express an arbitrary percentage.
- **Rollback**: publish a new manifest (`sequence+1`) that marks the bad version `withdrawn`, keeps the last good one `active` and adds `rollback:{from:[bad], to:good}`. Only installs currently on a `from` version may move "down", implemented with Tauri's `version_comparator` (docs "Allowing downgrades") rather than the global `allowDowngrades`, because the latter "removes the only guard" `[TPU config.rs#L140-L143]`. Withdrawal must also stop staged rollout (`rolloutBp: 0`).
- **Tested verifier (Node 24.19.0)**: valid manifest accepted; tampered byte, wrong channel, expired, `sequence` rollback and unknown `kid` were each rejected [local run]:

```js
import { createHash, createPublicKey, verify } from 'node:crypto';
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const DOMAIN = Buffer.from('vivahlens-release-manifest-v1\n');
const toKey = (raw32) => createPublicKey({ key: Buffer.concat([SPKI, raw32]), format: 'der', type: 'spki' });
export function verifyManifest({ bytes, sigDoc, pinned, expectedChannel, state, now = Date.now() }) {
  const pub = pinned[sigDoc.kid]; if (!pub) throw new Error('unknown kid');
  const sig = Buffer.from(sigDoc.sig, 'base64'); if (sig.length !== 64) throw new Error('bad signature length');
  if (!verify(null, Buffer.concat([DOMAIN, bytes]), toKey(pub), sig)) throw new Error('bad signature');
  const m = JSON.parse(bytes.toString('utf8'));                       // parse only after verification
  if (m.schema !== 1 || m.channel !== expectedChannel) throw new Error('schema/channel');
  if (!(Date.parse(m.expiresAt) > now)) throw new Error('expired (freeze)');
  if (m.sequence < state.lastSequence) throw new Error('sequence went backwards (rollback)');
  if (m.sequence === state.lastSequence && state.lastSha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('same sequence, different bytes');
  return m;
}
export const bucket = (installId, version) => createHash('sha256').update(`${installId}\n${version}`).digest().readUInt32BE(0) % 10000;
```

### Evidence (URLs) (all retrieved 2026-11-22)
- Tauri updater docs: https://v2.tauri.app/plugin/updater/ (anchors `#signing-updates`, `#tauri-configuration`, `#static-json-file`, `#dynamic-update-server`, `#runtime-configuration`, `#allowing-downgrades`)
- Updater plugin source: `[TPU updater.rs]`, `[TPU config.rs]` (see shorthand table); Tauri CLI: `[TCLI signer/generate.rs]`, `[TCLI signer/sign.rs]`, `[TCLI helpers/updater_signature.rs]`
- minisign spec/usage: https://jedisct1.github.io/minisign/ (sections "Signature format", "Public key format", "Trusted comments", "Pre-hashing"); verifier crate used by Tauri: `[MSV]`
- RFC 8032: https://www.rfc-editor.org/rfc/rfc8032 ; RFC 8410: https://www.rfc-editor.org/rfc/rfc8410 ; RFC 8785 (JCS): https://www.rfc-editor.org/rfc/rfc8785
- Node crypto: https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoverifyalgorithm-data-key-signature-callback , https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptocreatepublickeykey
- Sparkle: https://sparkle-project.org/documentation/ , https://sparkle-project.org/documentation/publishing/ (channels, phased rollout, critical updates), https://sparkle-project.org/documentation/customization/ (security settings)
- TUF: https://theupdateframework.github.io/specification/latest/

### Impact on plan
- `ARCHITECTURE_AND_PLAN.md:617` promises "channels (alpha/beta/stable) with staged rollout and one-click rollback via the updater manifest" and `:557` lists `GET /updates/manifest`. **Tauri's manifest cannot carry channels, percentages or a signature**: channels are URL conventions, rollout needs our own logic, and the manifest is unsigned. Build §1.7 as a thin signed layer; do not assume the Tauri JSON provides it.
- Turn on `requireSignedVersion` from the very first release and sign with `--app-version` (re-signing old releases later is the only way to flip it on). Keep `allowDowngrades` **off**; use a scoped `version_comparator` for rollback.
- `ARCHITECTURE_AND_PLAN.md:642` ("Signed updater manifests, offline key custody, key rotation") is implementable with Node `crypto` alone: SPKI prefix + `crypto.verify(null, …)`; no native module. Vectors A/B above are ready-made unit tests for a minisign verifier; the manifest verifier needs the negative tests shown.
- Reject legacy `Ed` minisign signatures in our own verifier (the plugin accepts them: `allow_legacy = true`).
- `{{bundle_type}}`, `riscv64` and `requireSignedVersion` come from source/config comments, not the docs page: pin the plugin version and re-check on upgrade.

---

## 2. AWS Signature Version 4 presigned URLs (S3 and S3-compatible storage)

### Answer

**2.0 Where the spec lives now.** The S3 API-reference page "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)" is **gone from the live site**: on 2026-11-22 `https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html` (and the sibling `sig-v4-*` pages) redirect to the API index (the TOC `toc-contents.json` has no signature pages). The page text and test vector below are from the **Wayback capture of 2026-06-09** (`https://web.archive.org/web/20260609180100/https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html`, an archived copy of AWS's own page). The live, canonical algorithm description is the IAM User Guide page "Create a signed AWS API request" (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html); S3 behaviour for presigned URLs is in the S3 User Guide (https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).

**2.1 Query parameters of a presigned URL** (archived S3 page, parameter table)

| Parameter | Value / rule |
|---|---|
| `X-Amz-Algorithm` | `AWS4-HMAC-SHA256` |
| `X-Amz-Credential` | `<access-key-id>/<yyyymmdd>/<region>/s3/aws4_request`; the `/` must be sent as `%2F` |
| `X-Amz-Date` | ISO 8601 basic, UTC: `yyyyMMddTHHmmssZ` (e.g. `20130524T000000Z`) |
| `X-Amz-Expires` | integer seconds, **minimum 1, maximum 604800 (7 days)** "because the signing key … is valid for up to seven days" |
| `X-Amz-SignedHeaders` | must include `host` and any `x-amz-*` header you will send; AWS advises signing every header you will include |
| `X-Amz-Signature` | lowercase hex HMAC-SHA256 (added last, **excluded** from the canonical query string) |
| `X-Amz-Security-Token` | optional; required in the URL (and signed) when using STS credentials |

**2.2 Canonical request / string to sign / signing key** (IAM guide "Create a canonical request … Derive a signing key"; archived S3 page "Calculating a Signature")

```
CanonicalRequest =  HTTPMethod            + "\n"
                  + CanonicalURI          + "\n"   URI-encoded absolute path ("/" if empty); "/" in the object key is NOT encoded
                  + CanonicalQueryString  + "\n"   every query param EXCEPT X-Amz-Signature; names and values URI-encoded
                                                   individually, sorted by encoded name; "name=" for valueless params; "" if none
                  + CanonicalHeaders      + "\n"   each "lowercase(name):trim(value)\n" sorted; MUST contain host (+ x-amz-* sent);
                                                   (so the block ends with a blank line before SignedHeaders)
                  + SignedHeaders         + "\n"   "host" or "host;x-amz-meta-foo" (sorted, lowercase, ';')
                  + HashedPayload                  presigned: the LITERAL string  UNSIGNED-PAYLOAD
StringToSign     =  "AWS4-HMAC-SHA256\n" + yyyymmddThhmmssZ + "\n" + yyyymmdd/region/s3/aws4_request + "\n" + hex(SHA256(CanonicalRequest))   (no trailing newline)
kDate = HMAC("AWS4"+secret, yyyymmdd); kRegion = HMAC(kDate, region); kService = HMAC(kRegion, "s3"); kSigning = HMAC(kService, "aws4_request")
Signature        =  hex(HMAC-SHA256(kSigning, StringToSign))   (lowercase hex)
```
- The archived S3 page states the presign differences: no payload hash (use the constant `UNSIGNED-PAYLOAD`), the canonical query must include **all** parameters except `X-Amz-Signature`, `host` (+ any `x-amz-*`) must be signed, and a signed header that is also a signed query parameter with a different value gives `InvalidRequest`.
- **Ambiguity in the live IAM page:** it says to "include the literal string `UNSIGNED-PAYLOAD`" but also prints `Hex(SHA256Hash("UNSIGNED-PAYLOAD"))`. The **literal string** is what reproduces the official vector below [local run].
- **UriEncode** (IAM guide + archived S3 page): encode every byte except `A-Z a-z 0-9 - . _ ~`; space is `%20` (never `+`); hex digits uppercase; `/` is encoded everywhere **except in the object key name**. AWS warns that platform encoders "might not work … write your own". [local run] `encodeURIComponent("!*'()~")` returns `!*'()~` unchanged, so JavaScript needs a custom encoder (`! * ' ( )` must become `%21 %2A %27 %28 %29`).
- Double-encoding of path segments for non-S3 services is **not** stated on the page I read (UNVERIFIED here); S3 encodes once.

**2.3 Official test vector** (archived S3 page, "An Example"; AWS: "You can use this example as a test case … you must use the same bucket name, object key, time stamp, and the following example credentials")

| Input | Value |
|---|---|
| AWSAccessKeyId / AWSSecretAccessKey | `AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |
| Request | `GET https://examplebucket.s3.amazonaws.com/test.txt`, time `Fri, 24 May 2013 00:00:00 GMT`, region `us-east-1`, `X-Amz-Expires=86400`, `X-Amz-SignedHeaders=host` |
| CanonicalRequest (`\n` shown) | `GET\n/test.txt\nX-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host\nhost:examplebucket.s3.amazonaws.com\n\nhost\nUNSIGNED-PAYLOAD` |
| Hex SHA-256 of CanonicalRequest | `3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04` |
| StringToSign (`\n` shown) | `AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04` |
| **Signature** | **`aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404`** |
| Final URL | `https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404` |

The page's "Example 2" (with `X-Amz-Security-Token`) prints `<signature-value>` only, so it is **not** usable as a vector. **[local run, Node 24.19.0]** the implementation below reproduced the canonical-request hash, the signature and the full URL byte-for-byte.

```js
import { createHash, createHmac } from 'node:crypto';
const hmac = (k, d) => createHmac('sha256', k).update(d, 'utf8').digest();
const hex = (d) => createHash('sha256').update(d, 'utf8').digest('hex');
export function uriEncode(s, keepSlash = false) {           // AWS rules, byte-wise on UTF-8
  let o = ''; for (const b of Buffer.from(s, 'utf8')) { const c = String.fromCharCode(b);
    o += (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0'); } return o; }
export function presign({ method = 'GET', host, path, accessKeyId, secretAccessKey, region, service = 's3', amzDate, expires, extraQuery = {}, sessionToken }) {
  const date = amzDate.slice(0, 8), scope = `${date}/${region}/${service}/aws4_request`;
  const q = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${accessKeyId}/${scope}`, 'X-Amz-Date': amzDate,
              'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': 'host', ...extraQuery };
  if (sessionToken) q['X-Amz-Security-Token'] = sessionToken;
  const cq = Object.entries(q).map(([k, v]) => [uriEncode(k), uriEncode(v)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, uriEncode(path, true), cq, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, date), region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(sts, 'utf8').digest('hex');
  return `https://${host}${uriEncode(path, true)}?${cq}&X-Amz-Signature=${signature}`;
}
// presign({host:'examplebucket.s3.amazonaws.com', path:'/test.txt', accessKeyId:'AKIAIOSFODNN7EXAMPLE', secretAccessKey:'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region:'us-east-1', amzDate:'20130524T000000Z', expires:86400})
//   === the "Final URL" above
```

**2.4 Expiry limits, credentials and bearer-token semantics**
- Max 7 days with SigV4 for an IAM user ("IAM user — Valid up to 7 days when you're using AWS Signature Version 4"); with temporary credentials the URL "can't be valid for longer than the credentials themselves"; console-created URLs: 1 minute to 12 hours; CLI/SDK: up to 7 days (S3 User Guide, expiration section). "You can use the presigned URL multiple times, up to the expiration date and time" (same page).
- Treat presigned URLs as **bearer tokens** (R2 docs "Security considerations").

**2.5 S3-compatible products: SigV4 presigned GET/PUT support (primary docs/code)**

| Product | GET | PUT | Max expiry | Notes / evidence |
|---|---|---|---|---|
| **AWS S3** | yes | yes ("GET for downloading, PUT for uploading" in the S3 User Guide) | 7 days (IAM user); shorter with temp creds | S3 User Guide above |
| **Cloudflare R2** | yes (+HEAD) | yes (+DELETE) | **1 s to 7 days (604,800 s)** | https://developers.cloudflare.com/r2/api/s3/presigned-urls/ : "requiring only your R2 API credentials and an implementation of the AWS Signature Version 4 signing algorithm"; endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (path-style `/<bucket>/<key>`) or `https://<bucket>.<ACCOUNT_ID>.r2.cloudflarestorage.com` (virtual-hosted); SDK `region: "auto"`; **works only on the S3 API domain, not custom domains**; **POST (HTML-form) uploads not supported**; restrict uploads by signing `Content-Type` (mismatch ⇒ `403/SignatureDoesNotMatch`); the sample URL carries `X-Amz-Content-Sha256=UNSIGNED-PAYLOAD` and `x-id=GetObject` as **query parameters**, so a verifier/signer must treat every non-signature query parameter as signed |
| **MinIO** | yes | yes by code path; **doc statement UNVERIFIED** | 604800 s (code); `mc share download` default `--expire 168h` (7 days) | Server code: any request with an `X-Amz-Credential` query parameter is treated as SigV4-presigned regardless of HTTP method `[MINIO auth-handler.go#L63-L66]`, `[MINIO auth-handler.go#L143-L147]`; dispatches to `doesPresignedSignatureMatch` `[MINIO auth-handler.go#L551-L552]`, `[MINIO signature-v4.go#L211-L246]`; `Expires > 604800` ⇒ `ErrMaximumExpires` `[MINIO signature-v4-parser.go#L230-L233]`. Docs: https://min.io/docs/minio/linux/reference/minio-mc/mc-share-download.html (presigned download URL, "Defaults to 168h"); `mc share upload` instead issues a **POST** upload (https://min.io/docs/minio/linux/reference/minio-mc/mc-share-upload.html), so no doc page found that names presigned PUT |
| **Backblaze B2 (S3-compatible API)** | yes | yes | UNVERIFIED (not on the page read) | https://www.backblaze.com/docs/cloud-storage-s3-compatible-api : "supports pre-signed URLs for downloading and uploading … AWS CLI, AWS Tools for PowerShell, s3cmd, and AWS SDKs"; **unsupported: "Browser-based uploads to pre-signed URLs using POST"**; whether SigV2 is accepted, and the region string format, were not on that page (UNVERIFIED) |

### Evidence (URLs) (all retrieved 2026-11-22)
- AWS (archived S3 page with the vector): https://web.archive.org/web/20260609180100/https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html ; live redirect check: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html ; TOC: https://docs.aws.amazon.com/AmazonS3/latest/API/toc-contents.json
- AWS IAM guide (live algorithm): https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html ; S3 User Guide: https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html
- R2: https://developers.cloudflare.com/r2/api/s3/presigned-urls/ ; MinIO: `[MINIO auth-handler.go]`, `[MINIO signature-v4.go]`, `[MINIO signature-v4-parser.go]` + the two `mc share` pages above ; B2: https://www.backblaze.com/docs/cloud-storage-s3-compatible-api

### Impact on plan
- `ARCHITECTURE_AND_PLAN.md:331,557,571` (S3-compatible storage, `POST /galleries/{id}/assets` "pre-signed upload", expiring gallery links) can be built with **`node:crypto` alone**; keep the vector above as a unit test (and a second test per provider with a recorded real URL).
- Pick **R2-compatible defaults**: region `auto`, S3-API host (never a custom domain), ≤ 7 days, sign `Content-Type` for PUT, no POST uploads. For the password-protected client gallery (§7e) mint **short-lived (minutes) presigned GETs on demand** instead of embedding week-long URLs: they are bearer tokens.
- Sign with `host` (+ `content-type`/`x-amz-*` you will send) and append **no** extra query parameters after signing; accept that SDK-produced URLs add `X-Amz-Content-Sha256`/`x-id` as signed query params when verifying URLs generated elsewhere.
- MinIO presigned **PUT** and B2 max expiry need a one-off integration test before being advertised as supported (code path exists for MinIO; B2 lists "uploading").

<!-- END-OF-PART-2 -->
