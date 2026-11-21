# Platform & Market Verification for VivahLens

**Retrieval date for all sources: 2026-11-22** (fetched with a web-fetch tool, not a browser; JS-rendered pages often returned empty price tables).
**Method:** primary sources only (vendor docs/pricing/ToS, specs, official law text). Where a primary source could not be read I write **UNVERIFIED** and say what I tried. Nothing is filled in from memory unless explicitly labelled *"analysis (not from a source)"*.
**Scope read of the plan:** `ARCHITECTURE_AND_PLAN.md` §2–§5 (LLM abstraction §2.4, local-first §2.6, Tauri §2.7, privacy §3, pricing/competitors §5).

> **Heads-up on freshness:** model names and prices below are what the vendor pages showed on 2026-11-22 (e.g. `gpt-6.2-astra`, Claude Fable 5.2, Gemini 4 Carbon). Several prices have **scheduled step-ups** (Gemini 4 Carbon doubles on 2026-12-01; Gemini 3.6 Flash doubles on 2027-01-01). Treat model IDs and prices as runtime-configurable data, not constants.

---

## 1. Vision-capable LLM APIs (OpenAI, Anthropic, Gemini, Azure OpenAI)

### Answer

**Limits and tokenisation**

| | OpenAI | Anthropic | Google Gemini | Azure OpenAI |
|---|---|---|---|---|
| Formats | PNG, JPEG, WEBP, non-animated GIF | JPEG, PNG, GIF, WebP | PNG, JPEG, WEBP, HEIC, HEIF | UNVERIFIED |
| Max images / request | 1,500 | 600 (100 for models with 200k context) | 3,600 | UNVERIFIED |
| Max size | 512 MB total payload/request; ≤30,000 patches per image (rejected, not auto-resized) | 10 MB per image (base64) on Claude API; 8000×8000 px max; 128 MB request cap; if >20 images in a request, each image must be ≤3,000 px/side | per-image byte limit UNVERIFIED | UNVERIFIED |
| Token cost rule | 32px patches × model multiplier (1.2 for current gpt-5.x/6 families); `detail` levels `low/high/original/auto`; `high` budget 2,500 patches | 28px patches, `⌈w/28⌉×⌈h/28⌉`. Claude 4.7+ models: up to 2,576 px long edge / 4,784 tokens; older: 1,568 px / 1,568 tokens | 258 tokens if ≤384px both sides, else 768×768 tiles at 258 tokens each (rough formula in docs); Gemini 3 adds `media_resolution` cap | UNVERIFIED |
| Structured output (JSON-schema enforced) | Yes (`structured_outputs`; constrains non-refusal output) | Yes (`output_config.format` json_schema, constrained decoding; strict tool use too) | Yes (JSON Schema in `response_format`) | Models "sold by Azure" include OpenAI models; schema-enforcement per model UNVERIFIED |
| Tool / function calling | Yes (`function_calling`; Chat Completions function calling only with `reasoning_effort=none` on Luna) | Yes (tool use; `strict: true`) | Yes (function calling) | UNVERIFIED |

**Pricing (USD per 1M tokens, standard tier, as shown 2026-11-22)**

| Provider | Flagship tested | In / Out | Cheap model tested | In / Out |
|---|---|---|---|---|
| OpenAI | `gpt-6.2-astra` (also `gpt-6-astra` $10/$50) | $8 / $40 | `gpt-6-luna` | $0.10 / $0.50 |
| Anthropic | Claude Fable 5.2 (Opus 5.5 is $4/$20) | $8 / $40 | Claude Haiku 5.5 (≤100k prompt) | $0.10 / $0.50 |
| Gemini | Gemini 4 Carbon | $2 / $10 through 2026-11-30, **$4 / $20 from 2026-12-01** | Gemini 3.5 Flash-Lite (cheapest I read; page not fully scanned) | $0.30 / $2.50 |
| Azure OpenAI | GPT-6.2 Astra / Sol SKUs exist (Global, Data Zone) | **UNVERIFIED** – price table rendered as "$-" (JS-loaded) | – | UNVERIFIED |

Batch discounts: OpenAI Batch/Flex 50% of standard; Gemini Batch/Flex shown at 50%; Azure Batch API stated as 50% off Global Standard; Anthropic batch discount UNVERIFIED (pricing page read only up to the cache columns).

**Rough cost per 500-photo batch** — assumptions: one 1500×1000 px (~1.5 MP) JPEG preview per photo, ~1,000 output tokens/photo, **no extra text-prompt tokens, no reasoning tokens, no style-reference images** (all three would add cost).

| Model | Image tokens/photo | $/photo | **$/500 photos** |
|---|---|---|---|
| OpenAI gpt-6.2-astra | 1,805 (1504 patches × 1.2)¹ | 0.0544 | **≈ $27.2** (≈ $13.6 with Batch) |
| OpenAI gpt-6-luna | 1,805¹ | 0.00068 | **≈ $0.34** |
| Anthropic Fable 5.2 | 1,944 (54×36 patches, not resized) | 0.0556 | **≈ $27.8** |
| Anthropic Haiku 5.5 | 1,944 | 0.00069 | **≈ $0.35** |
| Gemini 4 Carbon (until 11-30) | ~1,548 (6 tiles × 258)² | 0.0131 | **≈ $6.55** |
| Gemini 4 Carbon (from 12-01) | ~1,548² | 0.0262 | **≈ $13.1** |
| Gemini 3.5 Flash-Lite | ~1,548² | 0.00296 | **≈ $1.48** |
| Azure OpenAI | – | – | UNVERIFIED |

¹ OpenAI's sizing table lists `gpt-6-astra` and `gpt-5.6-*`; `gpt-6.2-astra`/`gpt-6-luna` rows are not listed, so I applied the `gpt-6-astra` rule (1.2× multiplier, 32px patches). 1.5 MP is under the 2,500-patch `high` budget so no resize.
² Gemini's tile formula is "rough"; I used the documented 960×540 → 3×2 example logic (ceil of dim/⌊min/1.5⌋). Gemini 3+ `media_resolution` could change it.

**Caveat that matters more than the table:** the "1k output tokens" is billed output *including hidden reasoning tokens* on reasoning models (OpenAI `gpt-6-luna` defaults to `medium` reasoning effort; Gemini output price "including thinking tokens"). A recipe-JSON call with reasoning on can easily cost several × the table. Set reasoning to the minimum, and meter actual `usage` fields.

### Evidence (URLs)
- OpenAI pricing: https://developers.openai.com/api/docs/pricing (redirect of platform.openai.com/docs/pricing)
- OpenAI image limits/tokenisation/detail levels: https://developers.openai.com/api/docs/guides/images-vision.md
- OpenAI structured outputs: https://developers.openai.com/api/docs/guides/structured-outputs.md
- gpt-6.2-astra (1,050,000 ctx, `structured_outputs`, `function_calling`, `image_input`, rejects reasoning `none`): https://developers.openai.com/api/docs/models/gpt-6.2-astra.md
- gpt-6-luna ($0.10/$0.50, image input, reasoning default medium, EU data residency): https://developers.openai.com/api/docs/models/gpt-6-luna.md
- Anthropic vision limits and tokens: https://platform.claude.com/docs/en/build-with-claude/vision
- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic structured outputs / strict tool use: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Gemini pricing: https://aistudio.google.com/docs/pricing (redirect of ai.google.dev/gemini-api/docs/pricing)
- Gemini image limits/tokens: https://aistudio.google.com/docs/image-understanding
- Gemini structured output / function calling: https://aistudio.google.com/docs/structured-output , https://aistudio.google.com/docs/function-calling
- Azure OpenAI pricing page (prices not rendered): https://azure.microsoft.com/en-us/pricing/details/azure-openai/
- Azure models list: https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure
- Azure vision how-to (only header retrieved): https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/gpt-with-vision

### Impact on plan
- **§2.4 `LLMProvider.capabilities` is too thin.** Add: `maxImagesPerRequest`, `maxImageBytes`, `imageTokenFn(w,h)`, `structuredOutput: "json_schema" | "json_mode" | "none"`, `reasoningControl`, `batchDiscount`, `pricePerMTokIn/Out` (versioned with effective dates). Provider-specific request shapes differ (OpenAI Responses `text.format`, Anthropic `output_config.format`, Gemini `response_format`), so the abstraction needs per-provider adapters, not just `generate()`.
- All four providers support schema-enforced JSON, so the plan's "strictly validate against Edit Recipe schema" is achievable server-side on every cloud provider; keep client-side validation anyway (schema subsets differ; refusals/incomplete outputs still occur per OpenAI docs).
- **BYO-key cost is small for cheap models (~$0.3–1.5 per 500 photos) and 20–80× larger for flagships (~$7–28).** Onboarding cost estimator (§4) should default to a cheap tier and require an explicit opt-in for flagships. A 1,500-photo wedding on a flagship ≈ $20–85 of the photographer's money; surface it.
- The <15 s/photo target (§4) is incompatible with Batch/Flex discounts (async); offer "economy (batch)" as a separate mode.
- Azure prices/limits are not verifiable from public pages in this session — require manual check before committing to an Azure adapter.

---

## 2. Data retention, ZDR, training on API data, DPA availability

### Answer

| | Training on API data | Default retention | ZDR | DPA |
|---|---|---|---|---|
| **OpenAI API** | Not used for training "unless you explicitly opt in" (since 2023-03-01) | Abuse-monitoring logs (may contain prompts/responses) kept **up to 30 days** by default, longer if legally required | Available only after approval (sales); also "Modified Abuse Monitoring". **Exception: image/file inputs are CSAM-scanned and, if flagged, retained for manual review even under ZDR/MAM** | Yes – OpenAI DPA, effective 2026-01-01, OpenAI is processor; signatory is OpenAI OpCo (or OpenAI Ireland for EEA/CH customers) |
| **Anthropic API** | "Anthropic may not train models on Customer Content from Services" (Commercial Terms) | Inputs/outputs auto-deleted within **30 days**; 2 years (inputs/outputs) / 7 years (classifier scores) if flagged as Usage Policy violation; "Covered Models" need 30-day retention regardless | ZDR on request via sales; per-org; structured outputs ZDR-eligible (schema cached up to 24h) | Yes – DPA incorporated into Commercial Terms; includes SCCs (Module 2/3) |
| **Gemini API** | **Paid tier (billing-enabled project): not used to improve products. Free/unpaid tier: used to improve products, human reviewers may read inputs/outputs; "Do not submit sensitive, confidential, or personal information".** EEA/CH/UK users get paid-style terms even on free quota | Paid: prompts/responses logged "for a limited period" for abuse detection. Separately, **developer-owned API logs are ON by default for Interactions API and for Generate Content in projects created on/after 2026-10-26; default retention 55 days** (adjustable 7/14/28/55) – private to the project, not used for training unless dataset is shared | No ZDR program found on pages read (UNVERIFIED) | Yes – paid services processed under Google's Data Processing Addendum for Products Where Google is a Data Processor |
| **Azure OpenAI** | Prompts/completions/embeddings not available to other customers or OpenAI, not used to train foundation models without permission | Stateless inference; abuse monitoring may sample prompts/completions for review (stored per customer resource/geography); stateful features (Responses API, Assistants, stored completions) persist data until deleted. Retention duration of abuse-monitoring store: UNVERIFIED (not in text I read) | "Modified abuse monitoring" can be applied for (managed customers) → no storage/human review | Yes – Microsoft Products and Services DPA governs |

### Evidence (URLs)
- OpenAI data controls (30-day abuse logs, ZDR/MAM, CSAM image exception): https://developers.openai.com/api/docs/guides/your-data.md
- OpenAI DPA: https://openai.com/policies/data-processing-addendum/
- Anthropic retention (ZDR, Covered Models): https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
- Anthropic commercial retention (30 days; 2y/7y flagged): https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
- Anthropic Commercial Terms (no training on Customer Content): https://www.anthropic.com/legal/commercial-terms
- Anthropic DPA: https://www.anthropic.com/legal/data-processing-addendum
- Gemini terms (unpaid vs paid data use, DPA link): https://aistudio.google.com/docs/terms (redirect of ai.google.dev/gemini-api/terms)
- Gemini logging (55 days, on-by-default from 2026-10-26): https://aistudio.google.com/docs/logs-policy
- Azure data privacy: https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/data-privacy

### Impact on plan
- **§3 says "implement DPAs with each supported LLM provider".** With true BYO key, the photographer (not VivahLens) is the customer who accepts the provider's DPA/terms; VivahLens only needs its **own** DPA with the photographer. Keep it that way: **send images desktop → provider directly**. The architecture diagram (§2.1) routes via a cloud "LLM Gateway"; if images transit it, VivahLens becomes a processor/sub-processor with Art. 28-style obligations (see §6) and needs its own sub-processor list. Use the gateway for metadata/billing only, or make it optional.
- **Hard gate for children's photos: do not allow a Gemini *free-tier* key.** Google's unpaid terms allow training and human review. The app cannot (UNVERIFIED) reliably detect key tier via API; add a mandatory attestation + doc link, and default Gemini to "disabled until paid billing confirmed".
- Surface per-provider facts in the UI: 30-day abuse logs (OpenAI/Anthropic), CSAM-scan retention exception (OpenAI), Gemini project logs on by default for new projects (tell users to turn logging off), Azure abuse-monitoring sampling.
- ZDR is sales-gated on OpenAI and Anthropic and unlikely for solo photographers; position "local model" and "Azure with modified abuse monitoring" as the strictest options, not "ZDR".

---

## 3. Local model path (Ollama / LM Studio)

### Answer
- **Ollama**: vision models accept an `images` array on its native API (base64 in REST). OpenAI-compatible `/v1/chat/completions` lists support for: vision (**base64 only – image URLs not supported**), `response_format`, JSON mode, tools, streaming, reasoning control; **`tool_choice` not supported**, logprobs not supported. `/v1/responses` exists (stateless only). Ollama's **native** `format` field accepts a full JSON Schema (structured outputs); the docs note "Ollama's cloud currently does not support structured outputs". Whether the OpenAI-style `response_format: {type: json_schema}` on `/v1/chat/completions` is schema-enforced (vs only JSON mode) is **UNVERIFIED** from the compat page (only "JSON mode" and the `response_format` field are ticked). Safest: use the native `/api/chat` with `format: <schema>`.
- **LM Studio**: `/v1/chat/completions` supports `response_format: {type: "json_schema", json_schema: {strict, schema}}` ("same format as OpenAI's Structured Output… expected to work via OpenAI client SDKs"); the OpenAI-compat overview says Chat Completions handles "text and images". Documented supported payload params are a limited list (`model, top_p, top_k, messages, temperature, max_tokens, stream, stop, presence_penalty, frequency_penalty, logit_bias, repeat_penalty, seed`) – `response_format` and `tools` are documented on their own pages (Structured Output, Tool Use).
- Local vision-model quality for style matching is **UNVERIFIED** (no primary benchmark read); Ollama's own docs use `gemma4` / `qwen3-vl:8b` as vision examples.

### Evidence (URLs)
- Ollama OpenAI compatibility: https://docs.ollama.com/api/openai-compatibility
- Ollama structured outputs: https://docs.ollama.com/capabilities/structured-outputs
- Ollama vision: https://docs.ollama.com/capabilities/vision
- LM Studio structured output: https://lmstudio.ai/docs/developer/openai-compat/structured-output
- LM Studio chat completions: https://lmstudio.ai/docs/developer/openai-compat/chat-completions

### Impact on plan
- §2.4's `local-endpoint` mode needs two sub-adapters (Ollama-native vs generic OpenAI-compat). Don't assume schema enforcement on the compat path: validate + retry, and prefer Ollama's native `format` schema / LM Studio `json_schema`.
- Send images as base64 data URIs to local endpoints (no URL mode).
- Local endpoints have no vendor DPA question, so they are the genuinely "no data leaves the machine" tier – make that the headline of the privacy story (§3), but gate quality expectations (UNVERIFIED) with a built-in golden-set eval before enabling.

---

## 4. Tauri v2: signing, updater, sidecars, secrets, WebView

### Answer
**Windows signing**
- Signing is not required to run but avoids SmartScreen warnings; **Windows 11 Smart App Control blocks unknown unsigned apps** even if not browser-downloaded.
- **Since 2024 EV certs no longer give instant SmartScreen reputation** – EV and OV build reputation the same way; a new release can still warn with either.
- Tauri's docs cover OV certs (thumbprint in `tauri.conf.json > bundle > windows`) and Microsoft's **Artifact Signing** (formerly "Trusted Signing") via a `signCommand` using `artifact-signing-cli` + Azure app-registration secrets.
- **Artifact Signing eligibility (Microsoft Learn):** Public Trust certs for *organizations* in US, Canada, EU, UK, Australia, NZ, Japan, South Korea, Singapore, Switzerland, Norway, Israel; *individual developers only in US or Canada*. Requires a paid Azure subscription (no free/trial). **India is not in the list.** Price/quotas: Basic 5,000 signatures/mo, Premium 100,000/mo; dollar prices UNVERIFIED (page rendered "$-").

**macOS**: Apple Developer Program $99/yr; `Developer ID Application` cert for outside-App-Store; **notarization required** with that cert, driven by env vars (`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`, or Apple ID); signing must be done on an Apple device; ad-hoc (`-`) signing still forces users to allow the app manually.

**Updater**: update signature verification **cannot be disabled**. You generate a keypair with `tauri signer generate`; public key goes in `tauri.conf.json`; private key via `TAURI_SIGNING_PRIVATE_KEY` at build (`.env` files do not work); **losing the private key means you cannot ship updates to installed users**. Artifacts: `.app.tar.gz(.sig)` (mac), NSIS/MSI `.sig` (Windows). This is separate from OS code signing.

**Sidecars**: `bundle.externalBin` with a per-target-triple filename suffix (e.g. `-x86_64-pc-windows-msvc`, `-aarch64-apple-darwin`); launched via the shell plugin `app.shell().sidecar(name)`; docs name Python CLIs bundled with PyInstaller as a common use. **darktable is GPL-3.0** (GitHub repo license badge); `darktable-cli` runs headless and takes input, optional XMP, output, `--style`, `--core --configdir`.

**Secrets**: Tauri has an official **Stronghold** plugin (IOTA Stronghold, password-derived key – not OS keychain). OS-keychain access is via the Rust `keyring` ecosystem: Keychain Services on macOS, **Windows Credential Manager** on Windows, Secret Service on Linux. Note the crate has been restructured: the simple `Entry` API is behind the default `v1` feature; apps wanting control are told to use `keyring-core` + individual store crates. (crate license: UNVERIFIED – could not read Cargo.toml.)

**WebView claims**: Tauri uses **WebView2 (Chromium/Edge) on Windows** – self-updating, preinstalled on Windows 11, installer ensures it on older Windows – and **WKWebView (WebKit) on macOS**, which "is updated with the regular OS updates… unsupported macOS versions do not receive WebKit updates". So Windows gets a consistent evergreen Chromium; macOS web-platform features depend on the user's OS version. I did **not** verify the plan's comparative claims about Electron/MAUI/Flutter (no primary source read); treat those table rows as unverified.

### Evidence (URLs)
- Windows signing: https://v2.tauri.app/distribute/sign/windows/
- macOS signing/notarization: https://v2.tauri.app/distribute/sign/macos/
- Artifact Signing quickstart (geography): https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- Artifact Signing FAQ (paid subscription): https://learn.microsoft.com/en-us/azure/artifact-signing/faq
- Artifact Signing pricing (not rendered): https://azure.microsoft.com/en-us/pricing/details/artifact-signing/
- Updater: https://v2.tauri.app/plugin/updater/
- Sidecar: https://v2.tauri.app/develop/sidecar/
- Stronghold: https://v2.tauri.app/plugin/stronghold/
- keyring: https://docs.rs/keyring/latest/keyring/ , https://docs.rs/keyring/latest/keyring/v1/index.html
- WebView versions: https://v2.tauri.app/reference/webview-versions/
- darktable license badge: https://github.com/darktable-org/darktable ; darktable-cli: https://docs.darktable.org/usermanual/development/en/special-topics/program-invocation/darktable-cli/

### Impact on plan
- §3 says Authenticode/SmartScreen reputation will be solved by signing: **adjust expectations** – signing helps but does not guarantee zero warnings, even with EV. Budget for early-release SmartScreen friction and submit builds to Microsoft for review (Tauri docs suggest).
- **If the legal entity is Indian, Azure Artifact Signing public-trust is not available to it** (per the geography note) → plan a traditional OV/EV cert from a CA, or incorporate/sign through an eligible entity. Decide this in Phase 0, not at launch.
- Add to §7.1: updater private-key custody/backup + rotation plan (loss = stranded installs).
- Sidecars: **do not bundle `darktable-cli` in v1** – it is GPL-3.0; the plan's "detect installed editor" already avoids it. If bundled later, ship as a separate executable with GPL notices and source offer (*analysis, not from a source – confirm with counsel*). Per-triple binaries multiply CI matrix (win-x64, win-arm64, mac-arm64, mac-x64).
- Replace "Windows Credential Manager (DPAPI)" wording: the verified fact is "Credential Manager / Keychain via `keyring`"; the DPAPI backing is UNVERIFIED. Prefer OS keychain over Stronghold for API keys (no user-passphrase prompt).
- §2.7: add WKWebView-version-by-macOS to the compatibility matrix; set a minimum macOS.

---

## 5. Competitors – official pricing and features

### Answer (snapshot 2026-11-22; several are **Black Friday** prices – note dates)

| Product | Price (exact, as shown) | Features / editors (as stated) |
|---|---|---|
| **Imagen AI** (snapshot of pricing page, Wayback capture 2026-11-18; live site returned HTTP 403) | **Pay-as-you-go: from US$0.05/photo + US$7/month base fee** (unused balance rolls over as export credit). **Limitless: US$129/mo billed annually, US$165/mo billed monthly** (saves US$432/yr annually). Black Friday: first month of Limitless US$5, then US$165/mo. 1,000 free edits to start. Table rows (labels lost in extraction) show add-ons "From US$12/mo", "From US$3/mo", and "US$0.01 per photo" items (incl. AI tools) on PAYG | Limitless includes AI culling, all editing/retouching, AI tools, unlimited exports; "for photographers who shoot their own work"; business plans add API access. Lightroom/Photoshop integration and video: **UNVERIFIED** (not on the page text I got) |
| **Aftershoot** (marketing pages; pricing page is a JS app and was empty) | **Select (culling): $10 → $8/mo billed annually (Black Friday offer, ends Nov 27)** "starts at $8/month"; states "every Aftershoot plan is truly unlimited… Unlike per-image tools that charge $0.05+ per photo". Edit/Retouch/Galleries plan prices: **UNVERIFIED** | Culling (AI-automated and assisted, duplicate grouping, closed-eye/blur flags, 30+ factors), **editing trained on your own edited photos or imported presets, 30+ pro styles**, RAW editor, retouching, client **Galleries**; exports/integrations: Lightroom Classic, Capture One, Photo Mechanic, Bridge; markets itself as **"100% offline. Images never leave your machine"**; 30-day free trial |
| **Narrative Select** | Lite $10/mo (originally $15); Standard $20/mo ($29); Premium $40/mo ($59); Ultra $60/mo ($79). Yearly-billing figures with "Lock in for 12 months and get 30% off" Black Friday banner; the "$ /mo" values appear to be the annual-billed promotional rates (monthly-billing price not clearly shown) | Unlimited images/projects; culling (eye & focus assessments, first-pass assessments, scenes, rank); **ships to Lightroom, Photoshop & Capture One**; "Edits straight to Lightroom Classic"; AI presets; **Personal AI Presets trained on your edits (Premium: 1 colour+1 B&W; Ultra: up to 5+5)**; users: 1/1/2/4 |
| **FilterPixel** (4th) | **Standard $7.50/mo ($90/yr), Pro $17.50/mo ($210/yr), Studio $32.50/mo ($390/yr)**, billed annually. Extra "DeepCull" shoots $7.99 each (a shoot = one import ≤5,500 photos); 3 free DeepCull shoots, no card | Unlimited basic culling + editing on all plans; DeepCull quota 20/70/140 shoots/yr; Expert Profiles; **Style DNA (profile from your Lightroom catalog)** on Pro+; client galleries with face search; "RAWs never leave your computer" |

### Evidence (URLs)
- Imagen pricing (archived 2026-11-18): https://web.archive.org/web/20261118094718/https://imagen-ai.com/pricing/ (live https://imagen-ai.com/pricing returned 403)
- Aftershoot culling page with pricing: https://aftershoot.com/selects/ ; home: https://aftershoot.com/ ; pricing app (empty to my fetcher): https://account.aftershoot.com/pricing
- Narrative: https://narrative.so/pricing
- FilterPixel: https://accounts.filterpixel.com/pricing (redirect of filterpixel.com/pricing)

### Impact on plan
- **Price anchor:** culling+editing competitors sell at **$7.50–$60/mo flat, "unlimited photos"**; the lowest-cost AI culler is $8/mo. The plan's per-photo-capped "Starter (X photos/mo)" tier (§5) is structurally out-of-line – competitors explicitly market "no per-image fees". Prefer flat tiers; Imagen's $129–165/mo shows the ceiling for "full automated edit".
- **"Local-first/files never leave your machine" is table stakes, not a differentiator** (Aftershoot, FilterPixel claim it). VivahLens *does* send previews to a cloud LLM, so the privacy story is *weaker* than Aftershoot's; the differentiators must be multi-editor adapters, BYO-LLM/local-LLM choice, and style learning – and the UI must be honest about previews leaving.
- **Style-learning-from-your-edits already exists** (Aftershoot, Narrative Personal AI Presets, FilterPixel Style DNA from LR catalog, Imagen) – the plan's "differentiation: style-learning" bullet (§5) must be rewritten as *LLM-transparent, editor-agnostic* style learning, and the XMP-diff ingester (§2b) is directly comparable to FilterPixel Style DNA.
- **Culling is a crowded $8–20/mo commodity**; §2.5/§2b "classical-CV culling" should be MVP-minimal or deferred, not a headline feature.
- Re-run this table before launch: Black Friday numbers are temporary and Aftershoot/Imagen plan details were only partly readable.

---

## 6. Privacy regulation (DPDP Act 2023, GDPR Art. 8/28, CCPA)

> **Source limitation:** India's official text locations (MeitY, IndiaCode, PIB) all returned HTTP 403/DNS failures to my fetcher. For DPDP I could only read an independent, non-government summary (PRS India) – **treat every DPDP statement below as secondary and UNVERIFIED against the official Act/Rules**. GDPR text was read directly from EUR-Lex. CCPA statutory text (leginfo, OAG) was blocked; I used the California Privacy Protection Agency (CPPA) FAQ.

### Answer
**India – DPDP Act 2023 (secondary source: PRS summary of the passed Bill)**
- Applies to digital personal data processed in India, and outside India when offering goods/services in India.
- Consent after notice (purpose + data); consent revocable. **Under-18: consent is given by parent/legal guardian.** Penalty schedule includes **up to ₹200 crore for non-fulfilment of obligations for children** and ₹250 crore for failing security safeguards.
- Data fiduciary duties: accuracy, reasonable security, breach notification to the Board and affected persons, erase when purpose met. Cross-border transfer allowed except to countries notified as restricted.
- **UNVERIFIED (not in what I could read):** the exact "verifiable parental consent" wording and mechanics (Act s.9 / Rules), the prohibition on tracking/behavioural monitoring of children, the processor-contract requirement (s.8(2)), whether DPDP Rules are in force and their phase-in dates, and any exemptions.

**EU – GDPR (read from EUR-Lex)**
- **Art. 8:** child's consent rule applies "in relation to the offer of information society services *directly to a child*" (16, member states may lower to 13); controller must make reasonable efforts to verify parental authorisation. VivahLens/photographer tools are not offered *to* children, so Art. 8 is **not obviously triggered** by the tool itself; children appear as data subjects in photos the photographer controls – the lawful basis (often contract/legitimate interests/consent from parents) is the photographer's decision.
- **Art. 28 (processor):** processing must be governed by a binding contract specifying subject-matter, duration, nature, purpose, data types, categories of data subjects; processor must act only on documented instructions, ensure confidentiality, take Art. 32 security measures, **not engage another processor without prior specific/general written authorisation (and inform of changes)**, flow down the same obligations to sub-processors (initial processor remains fully liable), assist with data-subject requests and Arts. 32–36, delete/return data at end, allow audits. **Art. 28(10): a processor that determines purposes/means is treated as a controller.**
- **Art. 30(2):** processors keep records of processing; the <250-employee exemption does not apply if processing is not occasional, risks rights, or includes special-category data.
- Art. 9 (special categories) is relevant if face-recognition/biometric ID is used in culling; I retrieved only the Article heading in this session – confirm text before relying on it.

**US – CCPA (CPPA FAQ)**
- Applies to for-profit businesses doing business in California that meet any threshold: **gross revenue ≥ $26.625M (effective 2025-01-01)**; buy/sell/share PI of ≥100,000 residents/households; or ≥50% revenue from selling/sharing PI. Separate obligations apply to **service providers and contractors**. Sensitive PI includes biometric information used to identify a consumer. Minors-specific rules (e.g., under-16 opt-in): **UNVERIFIED** (statute not readable).

### What a photographer-facing processor must do (derived strictly from the above)
1. Offer a **written processor agreement** (GDPR Art. 28(3) content list) – instructions-only processing, confidentiality, security, sub-processor authorisation + flow-down, assistance, deletion/return, audit.
2. Publish a **sub-processor list** and notify changes (Art. 28(2)) – includes any LLM provider *you* route data to (not if the photographer's own BYO key is called directly from the desktop).
3. Maintain **records of processing as processor** (Art. 30(2)).
4. Implement **security measures** (Art. 32; DPDP "reasonable security safeguards"), breach notification process (DPDP: Board + affected persons – timelines UNVERIFIED).
5. **Do not set your own purposes** (e.g., training on customers' photos) or you become a controller (Art. 28(10)).
6. Provide deletion/return of data and DSAR assistance.
7. For children: parental-consent obligations sit with the controller (photographer); give them a consent template (already in §3) and, for DPDP, confirm verifiable-consent mechanics from the official text.

### Evidence (URLs)
- DPDP (secondary summary): https://prsindia.org/billtrack/digital-personal-data-protection-bill-2023
- DPDP official locations attempted (all failed): https://www.meity.gov.in/writereaddata/files/Digital%20Personal%20Data%20Protection%20Act%202023.pdf (403), https://www.indiacode.nic.in/handle/123456789/22037 (403), https://www.pib.gov.in/ (403)
- GDPR official text (Arts. 8, 28, 30): https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32016R0679
- CCPA (CPPA FAQ): https://cppa.ca.gov/faq.html ; statute location attempted: https://leginfo.legislature.ca.gov/ (403), https://oag.ca.gov/privacy/ccpa (connection failed)

### Impact on plan
- §3 "treat all data as containing minors" is right; add **DPDP: verifiable parental consent sits with the photographer-as-fiduciary** – the ₹200 crore tier is for children's-data obligations, so this is the top legal risk to review with Indian counsel *using the official Act and Rules*.
- Decide explicitly: **VivahLens = processor** (default, keep data minimal, no own-purpose use, no training on customer photos) – and keep images off VivahLens servers by default (§2.6 already; make it a contractual promise).
- Add a "processor package" deliverable to Phase 1: DPA template, sub-processor list page, ROPA-as-processor, breach runbook, deletion SLA, consent clause template.
- "EXIF-stripped-of-GPS" is good minimisation but faces/names remain personal data; face clustering/biometric ID should be opt-in and legally reviewed.

---

## 7. RAW preview extraction + classical-CV culling blocks

### Answer
**RAW tools**

| Tool | What it does | License (as read) | Maturity signals | Closed-source Tauri implications |
|---|---|---|---|---|
| **LibRaw** | Extracts RAW data, metadata, **embedded preview/thumbnail**; also basic dcraw-derived conversion (not its focus) | **Dual: LGPL-2.1 *or* CDDL-1.0 — you choose**; "we do not guarantee that the licensing will not change in future versions" | Major releases every 1.5–3 yrs, minor bug-fix releases, snapshots; a CVE note was on the site (CVE-2026-111272 – read the notes) | *Analysis (not from a source; confirm with counsel):* LGPL needs the user to be able to relink/replace the library (dynamic linking, notices, license text); CDDL is file-level copyleft (modifications to LibRaw files stay open) and is generally easier for a closed app. Pick CDDL or LGPL-dynamic explicitly in the NOTICE file |
| **rawpy** (Python wrapper of LibRaw) | `raw.extract_thumb()` returns JPEG bytes or bitmap; raises `LibRawNoThumbnailError` / `LibRawUnsupportedThumbnailError` | Repo ships `LICENSE` (1.05 KB, text not rendered by my fetcher – **license text UNVERIFIED**) and `LICENSE.LibRaw`; wheels for Win/mac/Linux | 829★, 430 commits, stable releases built against stable LibRaw | Requires bundling Python (sidecar via PyInstaller is a documented Tauri pattern) – heavy; also inherits LibRaw license terms |
| **ExifTool** | Reads/writes EXIF/XMP/IPTC/maker notes for most camera RAWs; supports "PreviewImage" trailers; Windows exe bundles Strawberry Perl | **UNVERIFIED** – license section of exiftool.org (and README/GitHub) not retrievable by my fetcher; I did not assume | Very active: v13.64 released 2026-11-16 | Runs as a separate process (sidecar), so linking is not the issue; license text must be read before redistributing the Perl bundle |
| **dcraw** | Original RAW decoder from which LibRaw inherited methods | **UNVERIFIED** (not fetched) | LibRaw states it keeps dcraw-derived code only for compatibility | Prefer LibRaw over dcraw regardless |

**Classical-CV culling blocks**

| Block | Tool | License (as read) | Notes |
|---|---|---|---|
| Blur / focus | OpenCV `Laplacian()` (tutorial) → **variance-of-Laplacian** score | OpenCV ≥4.5.0 **Apache-2.0** (≤4.4.0 BSD-3) | Variance-of-Laplacian is a common heuristic, **not described in the OpenCV docs I read**; embedded RAW previews are ~1–2 MP so it will under-detect fine focus error at full-res (*analysis*) |
| Face detection | **YuNet** (opencv_zoo `face_detection_yunet`, "tiny millisecond-level face detector", WIDER-Face AP 0.88/0.87/0.75) | **MIT** (directory README) | Runs through OpenCV; ONNX; quantised variants exist |
| Eye state / expressions | **MediaPipe Face Landmarker**: 3D landmarks + **blendshape scores** (can derive blink/smile) | **Apache-2.0** (repo) | Web/Python/Android SDKs; models are `.task` bundles; model-file license UNVERIFIED |
| Landmarks | **dlib** | Library **Boost Software License 1.0** (read) | Pretrained model-weight licenses (e.g., 68-point predictor training data) **UNVERIFIED** – check before shipping weights in a commercial product |
| Near-duplicate | **imagehash** (pHash/aHash/dHash/wHash) | **BSD-2-Clause** (repo badge) | 3.9k★; Python only; in Rust use an equivalent crate (UNVERIFIED which) |

### Evidence (URLs)
- LibRaw about/licensing: https://www.libraw.org/about
- rawpy: https://github.com/letmaik/rawpy (README shows `extract_thumb`), license file listing https://github.com/letmaik/rawpy/blob/main/LICENSE
- ExifTool: https://exiftool.org/index.html (v13.64, 2026-11-16; license section not retrievable); https://metacpan.org/pod/Image::ExifTool
- OpenCV license: https://opencv.org/license/ ; Laplacian tutorial: https://docs.opencv.org/4.x/d5/db5/tutorial_laplace_operator.html
- YuNet: https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/README.md
- MediaPipe: https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker ; repo license badge https://github.com/google-ai-edge/mediapipe
- dlib license: https://dlib.net/license.html
- imagehash: https://github.com/JohannesBuchner/imagehash

### Impact on plan
- §2b/§2.5 culling: pick **YuNet (MIT) + MediaPipe blendshapes (Apache-2.0) + OpenCV Apache-2.0 + imagehash BSD** – no GPL/AGPL in the stack; avoid dlib *weights* until license is confirmed.
- Preview extraction: prefer **LibRaw (choose CDDL or dynamic-LGPL) in-process via Rust bindings** over a Python/rawpy sidecar to keep install size and attack surface down; keep ExifTool optional (external process) for maker-note metadata once its license text is read.
- Add a NOTICE/third-party-licences deliverable and CI license scan (§7.5).
- Note LibRaw's own warning that licensing may change – pin versions and vendor license text.

---

## 8. Payments/billing for desktop SaaS (Stripe vs Paddle vs Lemon Squeezy) + license enforcement

### Answer

| | **Stripe (Billing + Tax / Managed Payments)** | **Paddle** | **Lemon Squeezy** |
|---|---|---|---|
| Merchant of record? | **No** for Billing/Payments (you are MoR; Stripe Tax is an add-on). **Managed Payments = Stripe as MoR**, handles sales tax/VAT/GST in 80+ countries | **Yes** (calculates, collects, remits tax; "zero sales tax liability") | **Yes** (takes liability for tax, refunds, chargebacks, PCI) |
| Fees (as shown) | Billing: **0.7% of Billing volume** (pay-as-you-go; India page) + separate payment-processing fees (not read) | **5% + 50¢ per checkout transaction**, no monthly fee | **5% + 50¢ per transaction**; +1.5% international, +1.5% PayPal, +0.5% subscription payments; payout fee 1% via Stripe for non-US bank |
| Seller location | Stripe Tax lists "your business location" support per country (India status UNVERIFIED – table truncated). **Managed Payments supported business locations: US, CA, 30+ European countries, AU, HK, JP, SG – India is NOT listed**; also requires an eligibility review and a fully automated digital product | Works with software businesses anywhere except a sanctions-driven list (Afghanistan, Belarus, Cuba, Iran, North Korea, Russia, Syria, Venezuela, etc.). **India is not on the unsupported list** | Payout to bank/PayPal; seller-country eligibility UNVERIFIED |
| Tax coverage statement | Managed Payments: 80+ countries; Stripe Tax: per-country tables | "over 100 jurisdictions"; sells to 200+ countries; India/EU/US buyer-specific rules **UNVERIFIED** (country table not retrieved) | Handles VAT/sales tax for you; per-country specifics UNVERIFIED |
| License keys | None (not a licensing product) | **UNVERIFIED** (not documented on pages read) | **Built in**: generate keys per purchase, **activation limit**, license length, subscription-linked validity; License API + webhooks |

**Seat/licence enforcement options (what is verified):** Lemon Squeezy license keys + activation limits (a "seat" = an activation); Tauri updater signing is *not* a licensing mechanism. Keygen/other license servers and "sign your own license tokens + periodic online check" are options I did **not** verify from primary sources (UNVERIFIED).

### Evidence (URLs)
- Stripe Billing pricing: https://stripe.com/in/billing/pricing
- Stripe Managed Payments (MoR): https://docs.stripe.com/payments/managed-payments ; eligibility: https://docs.stripe.com/payments/managed-payments/eligibility
- Stripe Tax countries: https://docs.stripe.com/tax/supported-countries
- Paddle pricing: https://www.paddle.com/pricing ; tax: https://www.paddle.com/billing/tax-and-compliance ; supported countries: https://developer.paddle.com/concepts/sell/supported-countries-locales ; unsupported seller countries: https://www.paddle.com/help/start/intro-to-paddle/which-countries-are-supported-by-paddle
- Lemon Squeezy pricing/fees: https://www.lemonsqueezy.com/pricing , https://docs.lemonsqueezy.com/help/getting-started/fees ; MoR: https://docs.lemonsqueezy.com/help/payments/merchant-of-record ; sales tax: https://docs.lemonsqueezy.com/help/payments/sales-tax-vat ; license keys: https://docs.lemonsqueezy.com/help/licensing/generating-license-keys

### Impact on plan
- §5 is silent on billing mechanics. **If the company is India-based, Stripe Managed Payments is not available (not a listed business location); Paddle (anywhere not sanctioned) and Lemon Squeezy are the verifiable MoR options.** Decide MoR early: it determines whether you must register for VAT/GST/US sales tax yourself.
- Fee drag at the competitor price points in §5: a flat **$0.50 plus 5%** is **10% of a $10 plan, 6.7% of $29**, higher with Lemon Squeezy's +1.5% international/+0.5% subscription add-ons – bake into margin.
- Licensing: Lemon Squeezy gives key + activation-limit enforcement out of the box; for Paddle plan a small in-house signed-token license service (UNVERIFIED alternatives). Store the activation token in the OS keychain (§4 of this doc).
- Phase 0 spike: choose MoR + license mechanism, confirm India payout and tax treatment from vendor onboarding docs (not readable via public pages).

---

## Summary of changes recommended to ARCHITECTURE_AND_PLAN.md

- **§2.4 LLM abstraction:** extend `capabilities` with image limits/token function, structured-output mode, reasoning control, batch discount, and versioned price table with effective dates; use per-provider request adapters; make model IDs and prices remote-configurable (Gemini/OpenAI prices change on scheduled dates).
- **§2.4 / §4 cost UX:** show per-batch estimates; default to cheap tiers (~$0.3–1.5 / 500 photos) and gate flagships (~$7–28 / 500); meter `usage` including reasoning/thinking tokens; offer a separate async "economy (Batch)" mode since Batch conflicts with the <15 s target.
- **§2.1 / §2.6 / §3 data path:** send images directly desktop → provider (photographer's own DPA/key); keep the cloud LLM Gateway metadata-only or optional so VivahLens is not a sub-processor of image data by default.
- **§3 providers:** block/warn on Gemini free-tier keys (trains/human-reviews data); disclose OpenAI's CSAM-flagged-image retention exception and 30-day abuse logs, Anthropic 30-day deletion, Gemini project logging on by default for new projects (55 days), Azure abuse-monitoring sampling; state that ZDR is sales-gated (OpenAI/Anthropic).
- **§3 compliance:** add a "processor package" (DPA template, sub-processor list, processor ROPA, breach runbook, deletion SLA, consent clause); position VivahLens strictly as processor; obtain the **official DPDP Act/Rules text** (my fetch of MeitY/IndiaCode/PIB failed) and verify verifiable-parental-consent and processor-contract provisions with Indian counsel before launch.
- **§3 signing:** replace "Authenticode fixes SmartScreen" with the verified reality (EV no longer instant reputation since 2024; Smart App Control blocks unsigned); note **Azure Artifact Signing public trust is limited to listed countries (not India) and individual developers only in US/Canada** – choose a CA/entity strategy in Phase 0; add updater private-key custody/backup (loss strands installs); macOS needs $99/yr Developer ID + notarization credentials in CI.
- **§3 credentials:** wording → OS keychain via Rust `keyring` (Credential Manager / Keychain); drop the unverified "(DPAPI)" claim; avoid Stronghold for API keys.
- **§2.7:** keep Tauri but record that macOS WKWebView follows OS version (set minimum macOS) and Windows uses evergreen WebView2; mark the Electron/MAUI/Flutter comparison rows as unverified or source them.
- **§2.4 local mode:** split Ollama-native (`format` JSON Schema) from generic OpenAI-compat; base64 images only; validate+retry since compat-path schema enforcement is unverified; LM Studio supports `json_schema` response_format.
- **§2b/§2.5 culling & RAW:** use LibRaw (choose CDDL or dynamic LGPL) in-process for embedded previews; OpenCV (Apache-2.0) + YuNet (MIT) + MediaPipe (Apache-2.0) + imagehash (BSD-2); avoid dlib weights until licensed; do not bundle GPL `darktable-cli` in v1; add NOTICE file + CI license scan; read ExifTool's license text before redistributing it.
- **§5 competitors/pricing:** replace per-photo-capped Starter with flat tiers; anchor against $8–$60/mo (Aftershoot Select $8 annual, Narrative $10–$60, FilterPixel $7.50–$32.50, Imagen $129–$165 or $0.05/photo + $7); drop "local-first privacy" and "style-learning" as sole differentiators (competitors claim both) and lead with editor-agnostic adapters + BYO/local LLM transparency; treat culling as commodity.
- **§5 billing:** add MoR decision (Paddle or Lemon Squeezy verifiable for an India-based seller; Stripe Managed Payments excludes India), model fee drag (5% + 50¢ ≈ 10% on $10), and choose license enforcement (Lemon Squeezy keys + activation limits, or in-house signed tokens).
- **§6 Phase 0:** add spikes for (a) signing-entity/cert path, (b) MoR + licensing, (c) official-DPDP legal review, (d) structured-output conformance test per provider/model, (e) refresh all UNVERIFIED items below.

### Items still UNVERIFIED (re-check before committing)
Azure OpenAI prices and image limits; Gemini per-image byte limit and Gemini 4-series image token cost; Anthropic Batch discount; Gemini ZDR; Azure abuse-monitoring retention days; Ollama OpenAI-compat `json_schema` enforcement; Artifact Signing dollar pricing; `keyring` crate license; rawpy/ExifTool/dcraw license text; dlib model-weight licenses; Imagen Lightroom/video support and Aftershoot edit/retouch prices; Paddle license-key support and India buyer tax handling; Lemon Squeezy seller-country eligibility and post-acquisition status; DPDP official text and Rules; CCPA statutory minors provisions.
