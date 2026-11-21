# Editing Automation Platform — Architecture & Delivery Plan

*AI-driven editing automation service for event photographers/videographers (weddings, birthdays, housewarmings, corporate events). Photographers upload RAW photos/video and sample finished work; the system learns their style and drives their own editing software (Adobe suite, Capture One, DxO, ON1, darktable, RawTherapee, Premiere, Resolve, Final Cut, CapCut, iMovie) to deliver edits fast. BYO editing software license + BYO LLM (any provider). Windows + macOS.*

**Status:** Draft v2 — architecture plan extended to a full-product plan (§7b–§7k added; §1–§6 corrected against primary-source verification).
**Last updated:** 2026-11-22
**Verification notes:** [docs/research/editor-integration-verification.md](docs/research/editor-integration-verification.md) · [docs/research/platform-and-market-verification.md](docs/research/platform-and-market-verification.md). Facts tagged **UNVERIFIED** below are tracked in §8 and the Phase 0 spikes.

---

## 0. Executive Summary & Go/No-Go

**Verdict: Conditional Go — but the product is NOT "instant cloud editing." It is a local-first AI co-pilot that drives software already installed and licensed on the photographer's own Windows/Mac machine, with a thin cloud layer for subscriptions, style profiles, and LLM orchestration.**

The single most important finding from the feasibility research changes the shape of the product:

> **Nearly every professional editor on the list (Lightroom Classic, Premiere Pro, Capture One, Final Cut Pro) can only be automated while running on the user's own machine, with the GUI process alive, under the user's own license — not as a headless server-side "render farm."** Adobe's General Terms §6.4 explicitly forbid using the desktop apps "as part of a hosted service... on behalf of any third party," and Premiere/Lightroom Classic plugins (UXP/Lua) execute *inside* the running application, not headlessly. Only **darktable, RawTherapee, and DaVinci Resolve (Studio)** have genuine server-side/headless automation paths. **CapCut and iMovie have no usable automation surface at all** and should be omitted from the roadmap (or handled only via risky/fragile GUI automation).

This means:
- **Architecture must be a local desktop "Agent"** installed on the photographer's machine that drives their already-licensed editors in-place, not a cloud service that ingests RAWs and edits them centrally for Adobe/Capture One/FCP workflows.
- **"Instant" delivery is realistic for darktable/RawTherapee/Resolve** (can run unattended, even on a cloud worker you operate) but for Adobe/Capture One/FCP, "instant" means *fast local automation while the photographer's machine is on*, not a 24/7 cloud pipeline.
- **BYO-LLM is unaffected** — this part of the plan is fully feasible: the LLM only needs to see preview-resolution images/metadata and emit a structured edit recipe; it never needs to touch the editing software directly.
- **This is still a strong business**, but it's an "AI co-pilot / smart automation layer for editors you already own" product, not a "send us your card, get back a finished album while you sleep" product — at least not for Adobe/Capture One/FCP. Set that expectation with photographers from day one.

**Recommended MVP pivot:** Start with the **Green-rated, headless-capable tools** (darktable, RawTherapee) to prove the LLM → edit-recipe → applied-result loop with true cloud/instant delivery, while *simultaneously* shipping the **Lightroom Classic Lua plugin** (Yellow) as the flagship "familiar tool" entry point, run locally. This gives you one honestly-instant cloud path and one high-demand local path for the initial release, rather than over-promising on Adobe cloud automation that requires an Enterprise/Firefly Services contract you likely don't have yet.

---

## 1. Feasibility & Integration Research

*(Researched with source citations via web search; items marked "needs verification" could not be confirmed from official docs. Research date: 2026-11-22.)*

| Tool | OS Support | Automation Surface | Headless? | File-driven possible? | ToS / Licensing | Stability Risk | Feasibility | Recommended Strategy |
|---|---|---|---|---|---|---|---|---|
| **Lightroom Classic** | Win + Mac | Lua plug-in SDK (`LrPhoto`, `LrDevelopController`, `LrCatalog`). Persistent background plugin + IPC via `LrSocket` (send/receive), `LrShell` (launch agent), `LrHttp` (client) is shown by open-source plugins; **official SDK reference is login-gated → `applyDevelopSettings`/`applyDevelopPresetAsync`, XMP read/write and `catalog:addPhoto` are UNVERIFIED** | **No** — runs inside the app; Develop module must be active for develop writes | Partial — XMP written by LrC, but externally-changed files are flagged and need user action | Adobe General Terms §6.4 / §6.6 (quoted in research file; "on behalf of any third party" wording is ambiguous → counsel); Developer Terms §5.1 approval/withdrawal, §8.2(D) no Adobe product names in plugin name | Medium — stable but no Auto Tone/WB API | 🟡 Yellow | Ship a Lua plugin that runs **locally**; agent↔plugin over `LrSocket`; Phase 0 spike on develop-write throughput |
| **Lightroom (cloud/CC)** | Cloud REST | Lightroom API (`xmp/develop`, renditions) + Photoshop API v2 `/v2/edit` | **Yes** (cloud) | Yes — XMP upload or structured slider edits | Firefly Lightroom API and Photoshop API v1 **reached EOL 2026-07-31 (already past)**. Lightroom API: "entitled partner" only, no documented sign-up. Photoshop API v2: **Adobe Enterprise / Firefly Services contract**; v2 develop-settings support unconfirmed | High — platform in flux | 🔴/🟡 Gated, no self-serve path | Do **not** plan on this. Open an Adobe sales/partner enquiry in parallel; revisit only if granted |
| **Capture One** | Win + Mac (**AppleScript is Mac-only; no official Windows automation found**) | AppleScript/JXA (2026 dictionary adds colour editor, people/subject/background masks, AI crop), `.costyle` styles | **No** — app must be running | Partial — `.costyle` has no public spec; files are cross-platform copyable | EULA **not retrieved** — read the installer EULA | Medium — sdef changes per version | 🟡 Yellow (Mac only) | AppleScript automation on Mac; Windows = manual style import only |
| **DxO PhotoLab** | Win + Mac | **None found** on vendor support sites; proprietary `.dop`/`.preset` | Not officially | Unverified/unreliable | Unknown | High | 🔴 Red | Omit from near-term roadmap |
| **ON1 Photo RAW** | Win + Mac | None found except a post-export script hook (not an editing API) | Unknown | Unknown | Needs verification | Unknown | 🔴 Red | Omit; re-check periodically |
| **darktable** (pin 5.6.x) | Win/Mac/Linux | `darktable-cli`, XMP sidecars, embedded Lua. `--style` needs `--core --configdir`; use `--apply-custom-presets 0` for parallel runs; library DB can take precedence over XMP | **Yes** — designed for background/server jobs | **Yes** — CLI reads XMP history stacks directly | GPL-3.0 — invoke as a **separate process**; do not link; bundling needs source-offer compliance (see §7k) | Low–medium — XMP blobs are module-version dependent | 🟢 Green | Generate XMP/styles, batch via CLI; pin version in compatibility matrix |
| **RawTherapee** (pin 5.13) | Win/Mac/Linux | `rawtherapee-cli`; PP3 profiles via `-p` (layerable), `-s/-S`, `-c` must be last | **Yes** — dedicated CLI binary | **Yes** — layered PP3 | GPL-3.0 (same policy as darktable) | Low — plain-text, incremental format | 🟢 Green | Generate PP3, batch via CLI |
| **Premiere Pro** | Win + Mac | UXP (`premierepro` module, **v27.0.0 / UXP 9.4**; `Application` class removed): sequence assembly, generic effect creation, AME export verified. **Lumetri-specific controls and ExtendScript status UNVERIFIED** | **No** — plugin runs inside the app | No for `.prproj` (undocumented) | Adobe terms as above; UXP direct distribution = no review, Marketplace = review | Medium — breaking changes per major | 🟡 Yellow | Local UXP plugin: assemble sequence, cuts, export via AME; colour via LUT/Lumetri if API confirmed |
| **DaVinci Resolve** | Win + Mac + Linux | Python/Lua scripting API (README verified): `-nogui`, `SetLUT` (needs pre-discovered LUT paths), `SetCDL`, `ApplyGradeFromDRX`, `ImportTimelineFromFile` (FCPXML/OTIO/AAF/EDL/DRT). Resolve 21 adds a Photo page | **Yes** (`-nogui`) | Partial — DRX stills, LUT/CDL, timeline import | **Free-edition external scripting UNVERIFIED** (README title says Studio, text says API is a common superset). Test on a clean install | Medium — docs ship only with the app | 🟢 Green (Studio) / 🟡 Free unknown | Gate behind "Requires Resolve Studio" until the clean-install test passes |
| **Final Cut Pro** | **Mac only** | FCPXML (published reference **1.10**; latest version unverified). Colour via `filter-video` (Color Board/Curves/Wheels/HueSat) and masks. Workflow Extensions are a UI integration, **not headless** | **No** — FCP must render | Yes for editorial structure and listed colour filters | Not retrieved — needs verification | Medium — FCPXML versioned | 🟡 Yellow | Generate FCPXML locally, import, user renders |
| **CapCut** | Win + Mac + mobile | **None official.** Unofficial `draft_content.json` tools exist, newer versions encrypt drafts | No | Unofficial only | **ToS explicitly bans** automated scripts interacting with the service | Very high | 🔴 Red | Omit from roadmap; do not build on this — real breach/ban risk |
| **iMovie** | Mac + iOS only | **None.** Only "Send to Final Cut Pro" | No | No | n/a | n/a | 🔴 Red | Omit; redirect iMovie users to the FCP adapter |

### Key non-technical risk
**Adobe's General Terms (§3.1, §6.2, §6.4, §6.6)** forbid using the desktop apps in a hosted/third-party service and require accessing the software only via Adobe-sanctioned interfaces. The compliant pattern is: **a plugin/agent running locally, under the photographer's own Adobe login, acting only on their own machine** — never a server farm running Lightroom Classic/Premiere on customers' behalf. This is a hard legal constraint, not a preference.

**Verified (see research file):** Adobe General Terms §6.4/§6.6 text; Adobe Developer Terms §5.1, §6.6, §8.2(D); Resolve scripting README; `darktable-cli` and RawTherapee CLI flags; Adobe cloud API EOL/gating.

### Gaps still needing direct verification before committing engineering time
- Lightroom Classic SDK reference (login-gated): develop-setting write API, XMP, `catalog:addPhoto`, throughput.
- Resolve **free edition** external scripting — test on a clean install.
- Capture One EULA (installer text) and DxO/ON1 EULAs.
- Latest FCPXML version; Premiere UXP Lumetri API; ExtendScript status in current Premiere.
- Whether Adobe's "on behalf of any third party" language prohibits a *local* agent that drives the user's own copy — counsel opinion required (see §8 Q8).

---

## 2. Core Architecture

### 2.1 System Diagram

```mermaid
flowchart TB
    subgraph Desktop["Photographer's Machine (Windows or Mac)"]
        UI["Desktop Companion App\n(Tauri/.NET MAUI UI)"]
        Agent["Local Orchestration Agent\n(background service)"]
        subgraph Adapters["Editor Adapters (in-process / plugin)"]
            A1["Lightroom Classic\nLua Plugin"]
            A2["Premiere Pro\nUXP Plugin"]
            A3["Capture One\nAppleScript (Mac)"]
            A4["darktable-cli /\nRawTherapee-cli"]
            A5["DaVinci Resolve\nPython Scripting API"]
            A6["Final Cut Pro\nFCPXML writer"]
        end
        UI --> Agent
        Agent --> Adapters
        Agent --> LocalCache["Local RAW/Proxy Cache"]
    end

    subgraph Cloud["Cloud Backend (your SaaS)"]
        Auth["Auth / Subscription / Billing"]
        ProfileSvc["Style Profile Service"]
        RecipeSvc["Edit Recipe Store"]
        JobSvc["Job Queue & State"]
        LLMGateway["LLM Gateway\n(provider-agnostic, BYO key)"]
        Storage["Object Storage\n(proxies, recipes, metadata — NOT full RAWs by default)"]
    end

    subgraph LLMs["LLM Providers (user-selected, BYO)"]
        OpenAI["OpenAI"]
        Anthropic["Anthropic"]
        Google["Google Gemini"]
        AzureOAI["Azure OpenAI"]
        Local["Local (Ollama/LM Studio)"]
    end

    subgraph CloudWorkers["Optional Cloud Workers (headless-capable editors only)"]
        W1["darktable-cli worker"]
        W2["RawTherapee-cli worker"]
        W3["Resolve Studio -nogui worker"]
    end

    Agent <--> Auth
    Agent <--> ProfileSvc
    Agent <--> RecipeSvc
    Agent <--> JobSvc
    Agent --> LLMGateway
    LLMGateway --> LLMs
    JobSvc -. "only for Green-tier tools" .-> CloudWorkers
    CloudWorkers --> Storage
```

**Why this shape:**
- **Adobe/Capture One/FCP path:** everything stays local. The Agent calls the in-process adapter; only *previews + metadata* (not full RAWs) are sent to the LLM for analysis and recipe generation; the recipe comes back and the local adapter applies it to the full-res file on disk.
- **Image data path (changed in v2):** by default the desktop Agent sends previews **directly to the user's chosen LLM provider with the user's own key and DPA**. The cloud "LLM Gateway" is then metadata-only (usage, prompts versions, recipe validation rules, price tables) or optional (bundled-credits tier). This keeps VivahLens from becoming a processor/sub-processor of children's image data in the default configuration. If the bundled-credits tier proxies images, VivahLens **is** a processor and the §3 processor package applies in full.
- **darktable/RawTherapee/Resolve-Studio path:** can genuinely run as a cloud worker fleet you operate, since these tools are either open-source (no ToS issue) or scriptable headlessly with a license the *user* supplies — be careful: running Resolve Studio on *your* infrastructure on behalf of many customers still needs you to check Blackmagic's EULA per seat; the safest version is user-provided compute too.
- **One architecture, two execution locations**, selected per adapter's feasibility rating — this is the core design decision the research forces.

### 2.2 Editor Adapter Abstraction

```ts
interface EditorAdapter {
  id: string;                     // "lightroom-classic", "darktable", ...
  capabilities: AdapterCapabilities;
  executionModel: "local-plugin" | "local-cli" | "cloud-headless";

  detect(): Promise<InstalledEditorInfo | null>;   // version, path, license status
  importAssets(assets: AssetRef[]): Promise<ImportResult>;
  applyRecipe(asset: AssetRef, recipe: EditRecipe): Promise<ApplyResult>;
  export(asset: AssetRef, exportSpec: ExportSpec): Promise<ExportResult>;
  getProgress(jobId: string): AsyncIterable<ProgressEvent>;
  cancel(jobId: string): Promise<void>;
  translateRecipe(recipe: EditRecipe): NativeEditPayload;  // recipe -> XMP/PP3/UXP calls/etc.
}

interface AdapterCapabilities {
  supportsPhoto: boolean;
  supportsVideo: boolean;
  headless: boolean;
  requiresGuiOpen: boolean;
  fileDrivenOnly: boolean;        // true for Capture One, Final Cut
  os: ("windows" | "macos")[];
  supportedRecipeFields: string[]; // subset of EditRecipe this adapter honors
}
```

A new editor (or a future proprietary `EditorEngine`) is added by implementing this interface — the orchestrator, LLM gateway, and UI never need to change.

### 2.3 Edit Recipe (tool-agnostic intermediate format)

See draft JSON Schema in §7.3. Each adapter implements a **partial** translator (`translateRecipe`) and reports which fields it supports via `supportedRecipeFields`, so the UI can warn "this editor doesn't support split-toning" before a job runs.

### 2.4 LLM Provider Abstraction

```ts
interface LLMProvider {
  id: string;                      // "openai", "anthropic", "google", "azure-openai", "local-ollama", "local-lmstudio"
  authMode: "api-key" | "oauth" | "local-endpoint";
  capabilities: {
    vision: boolean; toolUse: boolean; maxContextTokens: number;
    maxImagesPerRequest: number; maxImageBytes: number;
    imageTokenCost(widthPx: number, heightPx: number): number;
    structuredOutput: "json-schema-enforced" | "json-mode" | "prompt-only";
    reasoningControl: boolean;     // can cap thinking/reasoning tokens
    batchDiscount?: { discount: number; maxLatencyHours: number };
  };
  priceTable(): VersionedPriceTable;               // remote-configurable, with effective dates
  estimateCost(request: LLMRequest): CostEstimate; // includes reasoning tokens
  generate(request: LLMRequest): Promise<LLMResponse>;   // must validate response against EditRecipe schema
}
```

- **Per-provider request adapters**; model IDs and prices are remote-config, because providers change them on scheduled dates.
- **Verified cost (rough, 500 photos, ~1.5 MP preview + ~1k output tokens, see research file):** cheap tiers ≈ **$0.34–$1.48**, flagship tiers ≈ **$6.55–$27.8**. Reasoning tokens raise real cost. Default to cheap tiers, gate flagships behind a cost confirmation, and meter reasoning tokens. Offer an async **Economy (Batch)** mode separately — it conflicts with the <15 s/photo target. Azure prices/limits are UNVERIFIED.
- **BYO API key**, not BYO consumer chat subscription. ChatGPT Plus / Claude Pro accounts have **no supported programmatic API** — their web/app sessions cannot be scripted without violating ToS and are fragile (session tokens, CAPTCHAs). Clearly tell users: "bring an API key from OpenAI/Anthropic/Google/Azure, or run a local model" — not "bring your ChatGPT subscription."
- **Provider data policies (verified, see §3):** block/warn on **Gemini free-tier keys** (data used for training/human review); disclose OpenAI's retention exception for CSAM-flagged images and 30-day abuse logs, Anthropic 30-day deletion, Gemini default project logging, Azure abuse-monitoring sampling. Zero-data-retention is sales-gated at OpenAI/Anthropic.
- **Local models:** Ollama-native endpoint supports a `format` JSON Schema; the generic OpenAI-compatible path is **not** assumed to enforce schemas (UNVERIFIED) — always base64 images, validate, retry. LM Studio supports `json_schema` response_format. Weaker style matching quality — set expectations.
- All LLM output is **strictly validated against the Edit Recipe JSON Schema** before any adapter touches it; reject/retry (max 2) on violation; never let the LLM call editor APIs directly. Run a per-provider/model **structured-output conformance test** in CI (Phase 0 spike).

### 2.5 Orchestration Design
- **Deterministic pipeline with one bounded LLM call per stage**, not a free-roaming agentic loop touching the filesystem — this keeps behavior predictable and auditable, which photographers (and your support team) will need.
  1. Cull (vision model or classical CV — blur/eyes-closed/duplicate detection can be pure code, not LLM, to save cost).
  2. Style match (vision-LLM compares style-reference set to new batch, emits parameters).
  3. Recipe generation (schema-validated JSON).
  4. Adapter translation + apply (deterministic code, no LLM).
  5. Human review/approval checkpoint.
  6. Export/deliver.
- Human-in-the-loop checkpoint is **mandatory before final export** in v1 — this is both a trust-building feature and a liability mitigation (you are not shipping unreviewed client-facing deliverables).

### 2.6 Local-first vs Cloud Processing
- RAW/video files **never need to leave the photographer's machine** for the Adobe/Capture One/FCP path — only downscaled previews (long-edge ~2048px JPEG) and metadata go to the LLM Gateway. This also solves the biggest unstated scaling problem: multi-GB RAW/video uploads.
- For the Green-tier cloud-worker path (darktable/RawTherapee/Resolve), offer it as an **opt-in** "cloud render" mode for users who want true unattended/cloud delivery and are comfortable uploading originals (with clear storage/retention and deletion-on-delivery policies).

### 2.7 Desktop Stack Recommendation

| Option | Windows | macOS | Native automation access (AppleScript/COM/Win32) | Verdict |
|---|---|---|---|---|
| **Tauri (Rust + WebView)** | Yes | Yes | Good via Rust FFI/shell-out to native tools | **Recommended** — small footprint, strong for a UI + background-agent shape, easy to shell out to CLIs (darktable-cli, rawtherapee-cli, Resolve Python scripts) and to launch/script other apps via OS APIs |
| Electron | Yes | Yes | Good, but heavier (Chromium per instance), higher RAM for an always-on agent | Workable fallback if team is JS-only; avoid for an always-running background agent |
| .NET MAUI | Yes | Yes (via Mac Catalyst) | Native Win32/COM access is first-class on Windows; macOS story weaker | Good if team is C#-heavy and you lean on Lua/UXP/AppleScript sub-processes anyway |
| Native (Swift+WinUI, separate codebases) | Yes | Yes | Best native integration | Highest long-term quality, 2x the UI maintenance cost — revisit post-PMF |
| Flutter | Yes | Yes | Automation still goes through platform channels/shell-out regardless | No meaningful advantage here over Tauri for this use case |

**Recommendation: Tauri** for the shared UI shell + a small per-OS native helper (Rust) that shells out to AppleScript/osascript on Mac and COM/PowerShell on Windows where needed, plus subprocess calls to CLIs and Python/Lua interpreters for Resolve/darktable. Windows uses evergreen WebView2; macOS WKWebView follows the OS version, so set a minimum macOS version. The Electron/MAUI/Flutter/native comparison rows above are engineering judgement, not sourced facts.

### 2.8 Job Queue, Batch, Resumability
- Each asset is a unit of work with states: `queued → culled → style-matched → recipe-generated → applying → review → exported → delivered`.
- Persist job state locally (SQLite) so a batch of 1,500 wedding photos survives app restarts/crashes; sync summary state to cloud for cross-device status only.
- Offline mode: culling and local-adapter application can run without connectivity once a recipe/style profile is cached; LLM calls queue and retry when online.

---

## 2b. Style-Learning Engine

| Approach | What it does | Use when |
|---|---|---|
| **Vision-LLM descriptive analysis** | LLM looks at sample finished photos, emits a structured "style profile" (tone curve tendencies, WB bias, contrast, grain, crop ratio habits, skin-tone treatment) | Default for cold-start, no historical before/after pairs |
| **Before/after regression** | If the photographer has old Lightroom catalogs/XMPs for the *same* images as finished samples, diff the XMP develop settings directly — exact numeric ground truth, no LLM guessing | Best quality when available — prioritize building the XMP-diff ingester |
| **Embedding + nearest-neighbor** | Embed new RAW preview + style-reference images; retrieve nearest reference exemplar to pick per-scene style variant | Use for per-scene adaptation within one album (indoor vs outdoor, ceremony vs reception) |
| **LUT/profile extraction** | Derive a 3D LUT or color-matching transform from reference JPEGs vs their RAWs | Good supplement for video color-matching; feeds Resolve CDL/LUT application |
| **Fine-tuning** | Not recommended for v1 — expensive, slow iteration, and you lose per-customer BYO-LLM flexibility (fine-tunes are provider/model specific) | Defer to Phase 4+ if a specific photographer's volume justifies it |

- **Per-scene adaptation**: cluster the batch by lighting/scene signature (simple CV: histogram, color temperature estimate) before invoking style matching, so indoor reception photos don't get outdoor-ceremony settings.
- **Album-level consistency**: after per-image recipes are generated, run a consistency pass (compare recipe deltas across the album) and flag outliers for review rather than silently normalizing — photographers are sensitive to "why did this one look different."
- **Smart culling**: pure CV/classical ML — **do not burn LLM tokens on this**. Verified building blocks: LibRaw (embedded-preview extraction; choose CDDL or dynamically-linked LGPL), OpenCV (Apache-2.0; Laplacian-variance blur), YuNet (MIT) / MediaPipe (Apache-2.0) for faces/eyes, `imagehash` (BSD-2) for near-duplicates. Avoid dlib model weights until licensed. Note competitors treat culling as a commodity — it is table stakes, not the moat.
- **Video**: highlight/highlight-reel detection via audio energy + motion + face/smile detection; beat-sync cuts via audio onset detection; color matching via the LUT-extraction approach feeding Resolve's `SetCDL`/`SetLUT`.
- **Quality evaluation**: maintain a small "golden dataset" per style profile (10–20 photographer-approved pairs); score new output via perceptual similarity metrics (e.g., LPIPS-style) **plus** the explicit approval/correction signal from the review UI — every manual override is training signal that refines the style profile (simple weighted-average or few-shot example update, not full fine-tuning, for v1).

---

## 3. Security, Privacy & Compliance

- **Sensitive imagery**: event photos routinely include children — treat all data as containing minors by default. Build consent language into the photographer's client agreement template you provide, not just your own ToS.
- **Data minimization to LLMs**: send **preview-resolution images + EXIF-stripped-of-GPS metadata** by default; make "send full-resolution" an explicit opt-in per job, with a visible indicator of what's about to leave the device.
- **Regulatory**: GDPR/CCPA/India DPDP all apply depending on where the photographer and subjects are. Position VivahLens strictly as a **processor** and ship a **processor package**: DPA template, sub-processor list, processor ROPA, breach-notification runbook, deletion SLA, and a client-agreement consent clause for the photographer. **The official DPDP Act/Rules text could not be fetched during research** (MeitY/IndiaCode/PIB errors; only a PRS summary was used) — obtain it and confirm verifiable-parental-consent and processor-contract provisions with Indian counsel before launch. CCPA minors provisions are UNVERIFIED. Local-first remains the main compliance story ("clients' photos don't leave your computer except as previews sent to the AI you chose").
- **Credential storage**: LLM API keys and editor OAuth tokens → OS keychain via the Rust `keyring` crate (Windows Credential Manager / macOS Keychain); never plaintext config or unencrypted synced storage; avoid Tauri Stronghold for API keys. (`keyring` license UNVERIFIED — check.)
- **App distribution**: macOS needs Apple Developer ID ($99/yr) + notarization credentials in CI. Windows: EV certs no longer give instant SmartScreen reputation and Smart App Control blocks unsigned binaries, so signing is mandatory but not sufficient. **Azure Artifact Signing public-trust is limited to listed countries (not India) and individuals only in US/Canada** — pick a signing entity/CA strategy in Phase 0. Auto-update via Tauri's signed updater; **updater private-key custody and offline backup are critical** (loss strands all installs). Telemetry strictly opt-in, scrubbed of customer content.

---

## 4. Product & UX

- **Personas**: solo wedding photographer (volume, speed-to-delivery pressure), small studio with 2–3 editors (consistency across editors is the pain point), high-volume event photographer (housewarmings/corporate — fast turnaround, lower per-photo attention).
- **MVP scope**: single-editor photo workflow (Lightroom Classic **or** darktable/RawTherapee for the honest-cloud path) + culling + style-match + review + export. No video in MVP.
- **Onboarding**: (1) detect installed editors on this machine → (2) connect LLM provider (paste API key or point to local endpoint, show a cost estimate) → (3) upload 10–30 style-reference finished photos → (4) run first batch of 50 photos as a guided trial.
- **Review/approve UI**: side-by-side before/after, batch-grid with per-photo thumbnails and a single-click "approve all" plus per-photo override sliders (map directly to Edit Recipe fields so corrections are structured, not free text) — every override feeds back into the style profile (§2b).
- **"Instant" — set a real target**: for the local path, target **first preview back in <15s per photo**, full batch of 500 photos locally applied in **<10 minutes** (dominated by the adapter/app speed, not your code); for the cloud-worker path (darktable/RawTherapee), target **<2 minutes for a 500-photo batch** end-to-end given you control the compute. Always show a live progress stream, never a spinner with no ETA.

---

## 5. Business Model & Pricing

- **Subscription tiers (revised against verified competitor pricing):** competitors sell **flat, unlimited-photo plans** ($7.50–$60/mo; Aftershoot from $8/mo annual, Narrative $10–$60, FilterPixel $7.50–$32.50; Imagen $129–$165/mo or $0.05/photo + $7/mo — retrieved dates in research file). Do **not** cap Starter by photos/month. Proposed: **Starter** (1 editor adapter, culling + styling, BYO key), **Pro** (all photo adapters, video, style-profile sharing), **Studio** (team seats, client galleries/delivery, API). Fix prices after Phase 1 willingness-to-pay interviews; anchor Starter near $15–25/mo.
- **LLM cost ownership**: BYO key = photographer pays provider directly (≈ $0.3–1.5 per 500 photos on cheap tiers); you charge only for software. Optional **bundled-credits tier** for non-technical users — meter and mark up; this makes you an image processor (§3).
- **Billing / merchant of record:** Stripe Managed Payments excludes India-based sellers; **Paddle or Lemon Squeezy** are the verifiable MoR options (Lemon Squeezy 5% + 50¢ ≈ 10% drag on a $10 plan). Paddle licence-key support, Lemon Squeezy seller eligibility/post-acquisition status are UNVERIFIED. License enforcement: Lemon Squeezy keys + activation limits, or in-house signed offline-verifiable tokens (see §7d).
- **Unit economics**: costs are cloud workers (if offered), small object storage, billing fees (~10%), and support (high — editor-version fragility).
- **Competitors**: Imagen AI, Aftershoot, Narrative, FilterPixel. **Local-first processing and personal style learning are already claimed by Aftershoot/Narrative/FilterPixel — not sufficient differentiators.** Differentiate on: (1) **editor-agnostic adapters** incl. video and darktable/RawTherapee/Resolve, (2) **BYO/local LLM with transparent cost and data path**, (3) structured, editable **Edit Recipe** output (the photographer sees and tunes parameters, not a black box), (4) event-album consistency tooling. Adobe shipping native AI remains a platform risk.
- **Platform risk**: Adobe/Blackmagic/Apple can change APIs or ship competing native AI at any time — mitigate with the Edit Recipe abstraction and by not over-indexing on any one adapter.

---

## 6. Roadmap & Delivery Plan

### Phase 0 — Spikes (2–4 weeks, 1–2 engineers)
1. Download and read the actual Lightroom Classic SDK PDF; confirm `applyDevelopSettings` batch behavior and whether a plugin can run as a passive background listener.
2. Prototype: LLM generates an XMP-equivalent recipe → apply via darktable-cli to 100 RAWs → photographer rates acceptance. **Success criterion: ≥70% "no manual correction needed."**
3. Confirm DaVinci Resolve Free vs Studio scripting restriction directly with Blackmagic docs/support.
4. Confirm Capture One Windows scripting story (research found none official) and read the installer EULA.
5. **(new)** Resolve clean-install test: does the free edition accept external scripting?
6. **(new)** Signing-entity/certificate path (Azure Artifact Signing excludes India) + macOS Developer ID.
7. **(new)** Merchant of record + license enforcement decision (Paddle vs Lemon Squeezy vs in-house tokens).
8. **(new)** Legal: official DPDP Act/Rules review, Adobe "third party" counsel opinion, GPL bundling policy.
9. **(new)** Structured-output conformance test per provider/model (OpenAI, Anthropic, Gemini, Ollama, LM Studio) against the EditRecipe schema.
10. **(new)** LrC develop-write throughput spike over `LrSocket` (needs the SDK download).

**Kill criterion:** if LLM-generated recipes need manual correction >50% of the time even after prompt/schema iteration, the style-matching approach needs fundamental rework before any further investment.

### Phase 1 — MVP (8–12 weeks)
- **Local** darktable + RawTherapee adapters (user-installed, invoked as separate processes — no GPL bundling) and the Lightroom Classic Lua plugin. Opt-in **cloud render** for Green-tier tools is a stretch goal, not an MVP gate (it requires uploading originals).
- Ingest, culling, style-match, recipe gen, review UI, export (§7b), accounts/licensing (§7d), installers + updater (§3), diagnostics (§7.6).
- Team: 2 backend/orchestration, 1 desktop (Tauri), 1 ML/prompt engineer, 1 designer (part-time).

**Exit criteria:** a real photographer runs a full wedding batch end-to-end and approves ≥80% of photos with zero or trivial correction; the §7j launch-readiness checklist is green for the MVP scope.

### Phase 2 — Delivery, Teams & Premiere Pro + Video (10 weeks)
- Client delivery & galleries, team seats / shared style profiles (§7e, §7d).
- Premiere UXP plugin for sequence assembly/export; highlight detection; beat-synced rough cut (§7f).
- **Risk:** UXP breaking changes across Premiere versions — pin tested versions, add a compatibility check at startup.
- **Exit:** a studio of 3 editors shares one style profile; a 5-minute highlight reel is rough-cut from a real event.

### Phase 3 — Open-source parity + hardening (6 weeks)
- Production reliability for darktable/RawTherapee (XMP module-version handling, batch-concurrency limits), optional cloud-render mode, performance/SLO tuning (§7h), accessibility/i18n pass (§7i).

### Phase 4 — Resolve, FCP, Capture One, ON1/DxO re-check (10–14 weeks)
- Resolve grading adapter (Studio-gated unless Phase 0 test passes); FCPXML generation for FCP; Capture One AppleScript adapter (Mac only); re-verify ON1/DxO.

### Phase 5 — CapCut/iMovie decision point + optional proprietary engine
- Do not build CapCut/iMovie automation on unofficial/ToS-violating tooling. Evaluate a proprietary lightweight editing engine (FFmpeg/OpenColorIO) as a fallback target for users without a supported pro tool.

### Risk Register (top items)

| Risk | Mitigation |
|---|---|
| Adobe ToS violation via hosted automation | Strict local-only execution model for Adobe adapters; legal review of plugin distribution before launch |
| LLM output breaks editor (invalid XMP/PP3/UXP call) | Strict schema validation + adapter-side dry-run/sandbox apply before touching the user's catalog |
| Editor version updates break adapters (UXP 27.0-style breaking changes) | Adapter version pinning + compatibility matrix + fast-follow CI against new editor betas |
| CapCut/iMovie pressure from users despite Red rating | Set expectations explicitly in marketing; do not quietly build on unofficial tooling |
| Resolve Free-edition scripting restriction confirmed true | Clearly gate the Resolve adapter behind "requires DaVinci Resolve Studio" in the UI |
| Adobe interprets "on behalf of any third party" to cover a local agent | Counsel opinion in Phase 0; fallback = ship darktable/RawTherapee-first and treat Adobe adapters as user-initiated plugins only |
| Competitors already claim local-first + personal style | Lead with editor-agnosticism, BYO/local LLM, editable recipes (§5) |
| Updater key or signing certificate lost/revoked | Offline key backup, documented rotation, second CA path |
| Gemini free-tier / provider retention exposes minors' images | Block free-tier keys, disclose provider policies in onboarding, default previews-only |
| GPL obligations triggered by bundling darktable/RawTherapee | Invoke user-installed binaries as separate processes; NOTICE file + CI license scan (§7k) |

---

## 7. Technical Deliverables

### 7.1 Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | Tauri (Rust + web UI) | Small footprint, strong shell-out/FFI for native automation, cross-platform |
| Background agent | Rust service (part of Tauri) or a separate OS service for always-on behavior | Low resource use for an always-running component |
| Cloud backend | Node.js/TypeScript or Go, Postgres, Redis (job queue) | Standard, fast to hire for |
| LLM Gateway | Thin provider-agnostic proxy (LiteLLM-style) | Normalizes OpenAI/Anthropic/Google/Azure/local calls behind one interface |
| Object storage | S3-compatible | Previews, recipes, exports only — not full RAWs by default |
| Local DB | SQLite | Per-machine job/state persistence |

### 7.2 Repository Structure (suggested)
```
/apps/desktop-client        (Tauri UI + agent)
/apps/cloud-api             (subscription, profiles, job metadata)
/apps/llm-gateway
/packages/edit-recipe-schema  (shared JSON Schema + codegen'd types)
/packages/editor-adapters
    /lightroom-classic
    /premiere-pro
    /capture-one
    /darktable
    /rawtherapee
    /davinci-resolve
    /final-cut-pro
/packages/style-engine
```

### 7.3 Draft Edit Recipe JSON Schema
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "EditRecipe",
  "type": "object",
  "required": ["version", "assetType", "adjustments"],
  "properties": {
    "version": { "type": "string", "const": "1.0" },
    "assetType": { "enum": ["photo", "video"] },
    "sourceStyleProfileId": { "type": "string" },
    "adjustments": {
      "type": "object",
      "properties": {
        "exposure":   { "type": "number", "minimum": -5, "maximum": 5 },
        "contrast":   { "type": "number", "minimum": -100, "maximum": 100 },
        "whiteBalance": {
          "type": "object",
          "properties": {
            "tempK": { "type": "number", "minimum": 2000, "maximum": 50000 },
            "tint":  { "type": "number", "minimum": -150, "maximum": 150 }
          }
        },
        "highlights": { "type": "number", "minimum": -100, "maximum": 100 },
        "shadows":    { "type": "number", "minimum": -100, "maximum": 100 },
        "whites":     { "type": "number", "minimum": -100, "maximum": 100 },
        "blacks":     { "type": "number", "minimum": -100, "maximum": 100 },
        "vibrance":   { "type": "number", "minimum": -100, "maximum": 100 },
        "saturation": { "type": "number", "minimum": -100, "maximum": 100 },
        "toneCurve": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "input":  { "type": "number", "minimum": 0, "maximum": 255 },
              "output": { "type": "number", "minimum": 0, "maximum": 255 }
            }
          }
        },
        "hsl": {
          "type": "object",
          "description": "Per-color-channel hue/saturation/luminance adjustments",
          "additionalProperties": {
            "type": "object",
            "properties": {
              "hue": { "type": "number", "minimum": -100, "maximum": 100 },
              "saturation": { "type": "number", "minimum": -100, "maximum": 100 },
              "luminance": { "type": "number", "minimum": -100, "maximum": 100 }
            }
          }
        },
        "splitToning": {
          "type": "object",
          "properties": {
            "highlightHue": { "type": "number", "minimum": 0, "maximum": 360 },
            "highlightSaturation": { "type": "number", "minimum": 0, "maximum": 100 },
            "shadowHue": { "type": "number", "minimum": 0, "maximum": 360 },
            "shadowSaturation": { "type": "number", "minimum": 0, "maximum": 100 },
            "balance": { "type": "number", "minimum": -100, "maximum": 100 }
          }
        },
        "crop": {
          "type": "object",
          "properties": {
            "aspectRatio": { "type": "string" },
            "x": { "type": "number" }, "y": { "type": "number" },
            "width": { "type": "number" }, "height": { "type": "number" },
            "rotationDeg": { "type": "number" }
          }
        },
        "noiseReduction": {
          "type": "object",
          "properties": {
            "luminance": { "type": "number", "minimum": 0, "maximum": 100 },
            "color": { "type": "number", "minimum": 0, "maximum": 100 }
          }
        },
        "sharpening": {
          "type": "object",
          "properties": {
            "amount": { "type": "number", "minimum": 0, "maximum": 150 },
            "radius": { "type": "number", "minimum": 0.5, "maximum": 3 }
          }
        },
        "lutRef": { "type": "string", "description": "Reference to a generated/extracted 3D LUT file" },
        "videoEdits": {
          "type": "object",
          "properties": {
            "cuts": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "clipId": { "type": "string" },
                  "inSec": { "type": "number" },
                  "outSec": { "type": "number" },
                  "transitionIn": { "enum": ["none", "cut", "crossfade", "dip-to-black"] }
                }
              }
            },
            "colorGrade": { "$ref": "#/properties/adjustments/properties/lutRef" },
            "cdl": {
              "type": "object",
              "properties": {
                "slope": { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3 },
                "offset": { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3 },
                "power": { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3 },
                "saturation": { "type": "number" }
              }
            }
          }
        }
      }
    },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "notes": { "type": "string" }
  }
}
```

### 7.4 Sequence Diagram — Upload → Style Learning → Edit → Review → Export

```mermaid
sequenceDiagram
    participant P as Photographer
    participant UI as Desktop UI
    participant Agent as Local Agent
    participant Gateway as LLM Gateway (cloud)
    participant LLM as LLM Provider
    participant Adapter as Editor Adapter
    participant Editor as Editing Software

    P->>UI: Upload RAW batch + style reference photos
    UI->>Agent: Create job
    Agent->>Agent: Run local culling (CV, no LLM)
    Agent->>Gateway: Send style-reference previews + metadata
    Gateway->>LLM: Analyze style (vision prompt)
    LLM-->>Gateway: Style profile JSON
    Gateway-->>Agent: Style profile stored

    loop For each kept photo
        Agent->>Gateway: Send photo preview + style profile
        Gateway->>LLM: Generate edit recipe
        LLM-->>Gateway: Candidate Edit Recipe JSON
        Gateway->>Gateway: Validate against schema
        Gateway-->>Agent: Validated Edit Recipe
        Agent->>Adapter: applyRecipe(asset, recipe)
        Adapter->>Editor: Native call (Lua/UXP/AppleScript/CLI)
        Editor-->>Adapter: Applied + preview rendered
        Adapter-->>Agent: ApplyResult + progress
    end

    Agent-->>UI: Batch ready for review
    P->>UI: Approve / override per photo
    UI->>Agent: Overrides (if any) -> feed style profile update
    Agent->>Adapter: export(asset, exportSpec)
    Adapter->>Editor: Export/render
    Editor-->>Adapter: Final file on disk
    Adapter-->>UI: Delivered
```

### 7.5 Testing Strategy
- **Adapter contract tests**: a shared test suite every adapter must pass (apply known recipe → assert resulting file/metadata matches expected within tolerance), run against pinned editor versions in CI where headless/CLI tools allow it (darktable, RawTherapee, Resolve); GUI-bound adapters (LrC, Premiere, Capture One) need a scheduled manual/VM-based regression pass per editor update.
- **Golden-image tests**: a fixed set of RAW + style-reference pairs with known-good expected recipes; flag any drift when prompts/models change.
- **LLM eval harness**: track recipe-schema-validity rate, "no correction needed" acceptance rate, and per-field deviation from golden recipes across model/provider changes — this is your core quality metric over time.
- **Cross-OS CI**: Windows + macOS runners for the Tauri shell and Rust agent; separate manual/VM lanes for Mac-only (Capture One AppleScript, FCP) and Windows-only edge cases.

### 7.6 Observability & Rollout
- Per-job structured logs (job id, adapter, recipe hash, LLM provider/model, latency, outcome) — scrub image content, keep only metadata.
- Staged rollout per adapter (beta flag), since each one has independent version-fragility risk.
- In-app diagnostics bundle (sanitized) for support to debug "my Lightroom plugin stopped applying edits" tickets quickly.

---

## 7b. Ingest, Asset & Data Model *(new in v2)*

**Ingest pipeline (per job):** select folder/card → hash (xxHash) + dedupe against the local library → read EXIF/XMP via LibRaw/ExifTool → extract the embedded JPEG preview (fallback: decode RAW at half-size) → write 2048px long-edge preview + 512px thumbnail into the cache → group by capture time/scene signature → enqueue. Originals are **never moved or modified**; edits are written as sidecars/catalog operations by the adapter. Supported inputs: major RAW families (CR2/CR3, NEF, ARW, RAF, ORF, DNG), JPEG/HEIC, and video (MP4/MOV/MXF/BRAW via editor, proxies via FFmpeg).

**Local SQLite schema (core tables):**

| Table | Key columns |
|---|---|
| `asset` | id, path, content_hash, kind (photo/video), capture_time, camera, lens, iso, scene_cluster_id, preview_path, thumb_path |
| `job` | id, name, event_type, adapter_id, style_profile_id, llm_provider, model, state, created_at, cost_estimate, cost_actual |
| `job_item` | job_id, asset_id, state (see §2.8), cull_score, cull_reasons, recipe_id, error_code, attempts, updated_at |
| `recipe` | id, asset_id, schema_version, json, source (llm/override/profile), confidence, hash |
| `style_profile` | id, name, version, descriptor_json, exemplar_ids, golden_set_id, created_at |
| `override` | id, recipe_id, field_path, old_value, new_value, user_id, created_at (feeds §2b) |
| `export_spec` / `delivery` | format, size, color space, sharpening, watermark, destination, gallery_id, status |
| `audit_event` | ts, actor, action, job_id, metadata (no image content) |

**Cloud (Postgres) schema:** `account`, `organization`, `seat`, `subscription`, `license_activation`, `style_profile_sync` (encrypted descriptors, no images), `usage_event` (counts, tokens, cost — no content), `gallery`, `gallery_asset`, `delivery_link`, `audit_event`, `price_table`, `model_catalog`.

**Schema migration policy:** forward-only versioned migrations on both stores; `EditRecipe.version` is bumped for breaking changes and the recipe store keeps a converter chain so old recipes remain re-appliable.

## 7c. Local Agent ↔ Editor IPC & Cloud API Contract *(new in v2)*

**Agent ↔ UI:** Tauri commands/events; the Agent owns the job state machine and is the single writer to SQLite.

**Agent ↔ adapters:**
- *CLI adapters* (darktable, RawTherapee, FFmpeg): subprocess with a per-job working dir, timeout, concurrency cap = physical cores − 1, stdout/stderr captured to structured logs.
- *Lightroom Classic plugin:* plugin starts a background task, opens an `LrSocket` to the Agent on a random loopback port, authenticates with a per-session token handed over in a launch file under the user profile (not the command line), and receives `applyRecipe` messages; replies with `ApplyResult` + progress. If LrC is closed the adapter reports `editor-not-running` and offers a launch action. Fallback if sockets prove unreliable: file-drop queue polled by the plugin.
- *Premiere UXP:* equivalent loopback WebSocket from the UXP panel to the Agent.
- *Capture One:* `osascript` per batch with a cap on call rate; *Resolve:* Python subprocess (`-nogui` where permitted); *FCP:* FCPXML file generation + import instruction.
- All loopback listeners bind to 127.0.0.1 only, require the session token, and reject unknown origins.

**Cloud REST API (v1) — resources:** `POST /auth/device` (device-code login), `GET/PUT /style-profiles`, `POST /usage-events`, `GET /entitlements` (signed), `GET /model-catalog` and `/price-table` (signed remote config), `POST /galleries`, `POST /galleries/{id}/assets` (pre-signed upload), `POST /delivery-links`, `GET /updates/manifest`, `POST /support/diagnostics` (user-initiated). OpenAPI spec lives in `/apps/cloud-api`; all write endpoints are idempotent (`Idempotency-Key`). Rate limits per account; 4xx/5xx error envelope with stable `error_code`.

## 7d. Accounts, Licensing, Billing & Teams *(new in v2)*

- **Identity:** email/password + OAuth (Google/Apple), TOTP 2FA, device-code login for the desktop app. Sessions are refresh tokens in the OS keychain.
- **Entitlements:** the server issues a **signed entitlement token** (plan, seats, adapter flags, expiry ≤ 7 days). The Agent verifies the signature offline and works fully offline within the grace window (14 days), then degrades to read-only/export-only — never destroys user work.
- **Seats & devices:** per-seat activation with a device cap (default 2); self-service deactivate.
- **Billing:** merchant-of-record (Paddle or Lemon Squeezy, decided in Phase 0) handles tax, invoices, refunds, dunning; webhooks drive entitlements. Trial: 14 days / one guided 50-photo batch, no card.
- **Teams (Studio tier):** org with admin/editor/viewer roles, shared style profiles with versioning and rollback, audit log, per-seat usage.
- **Data subject tools:** export and delete account in-app; deletion SLA published (§7k).

## 7e. Delivery, Galleries & Client Experience *(new in v2)*

- **Export presets:** web (sRGB, 2048px), print (AdobeRGB/ProPhoto, full-res, TIFF/JPEG), social, album-design; optional watermark and IPTC/copyright injection; GPS stripping default-on.
- **Delivery:** local folder, SFTP, or (Studio tier) hosted client gallery: pre-signed uploads, expiring password-protected links, favorites/selection by the client, download-all ZIP, retention-and-delete-on-expiry. Gallery data is the only point where originals/finals touch our cloud, and is opt-in and covered by the §7k processor package.
- **Client proofing loop:** client picks favorites → photographer-side "retouch these" queue → re-run adapter on the selected subset.
- **Notifications:** batch complete / needs review / failure, via desktop notification and email.

## 7f. Video Pipeline Detail *(new in v2)*

Scope is explicitly **assistive rough-cut + grade**, not auto-final edit.
1. Proxy generation with FFmpeg (H.264 720p) and audio extraction.
2. Analysis (local, no LLM): shot-boundary detection, audio energy/speech/music segmentation, motion score, face/smile detection, blur/shake detection.
3. Highlight selection by weighted score with a target duration; beat/onset detection (e.g., librosa-class algorithms) for music-synced cuts.
4. LLM stage (previews only): captions/scene labels over sampled keyframes, ordering for ceremony → reception narrative, producing `videoEdits` in the EditRecipe.
5. Adapter apply: Premiere UXP (sequence + AME export), Resolve (timeline import + LUT/CDL), FCP (FCPXML).
6. Review UI with timeline view; one-click swap of any suggested clip.
Colour matching uses LUT/CDL extraction (§2b). Music licensing is the photographer's responsibility; the app never bundles music.

## 7g. Error Handling, Recovery & Support *(new in v2)*

- **Error taxonomy** with stable codes: `LLM_SCHEMA_INVALID`, `LLM_RATE_LIMIT`, `LLM_AUTH`, `ADAPTER_EDITOR_NOT_RUNNING`, `ADAPTER_VERSION_UNSUPPORTED`, `ADAPTER_APPLY_FAILED`, `ASSET_UNREADABLE`, `DISK_FULL`, `ENTITLEMENT_EXPIRED`. Each maps to a user-facing message and a one-click remedy.
- **Retries:** exponential backoff with jitter on transient LLM/network errors; max 2 schema-repair retries; per-item failure never fails the batch — failed items go to a "needs attention" lane.
- **Safety:** adapters write to a **copy/sidecar first** and verify before committing; every apply is reversible via the job's undo log; originals are read-only.
- **Budget guardrails:** per-job spend cap with a confirmation when the estimate (incl. reasoning tokens) exceeds it.
- **Support:** in-app sanitized diagnostics bundle (§7.6), compatibility-matrix page, public status page, knowledge base + community channel, severity-based SLA for paid tiers. An "editor version unsupported" banner links directly to the matrix.

## 7h. Non-Functional Requirements & SLOs *(new in v2)*

| Area | Target |
|---|---|
| First preview per photo (local path) | < 15 s p90 (cheap-tier model) |
| 500-photo local batch apply | < 10 min p90, excluding LLM latency spikes |
| Cloud-render 500-photo batch (opt-in, Green tier) | < 2 min p90 end-to-end |
| Agent idle footprint | < 150 MB RAM, < 1% CPU |
| App start to ready | < 3 s |
| Crash-free sessions | ≥ 99.5% |
| Resumability | batch of 1,500 survives kill -9 with zero lost completed items |
| Cloud API availability | 99.9% monthly (entitlements degrade gracefully offline) |
| Minimum hardware | 16 GB RAM, SSD, 4 cores; Windows 10 22H2+/11, macOS (minimum set per WKWebView requirement) |

## 7i. Accessibility, Localization & UX Quality *(new in v2)*

- WCAG 2.2 AA for the desktop UI: full keyboard navigation of the review grid, screen-reader labels, high-contrast and reduced-motion modes, colour-managed previews (display profile aware) so the photographer judges tone correctly.
- i18n from day one (ICU message format); launch locales: English, Hindi; next: Spanish, German, Portuguese. Locale-aware currency/date and RTL-safe layout.
- Keyboard-first review shortcuts (approve, reject, compare, next scene) — expected by high-volume event shooters.
- UX validation: 5 moderated usability sessions per release milestone; task success ≥ 90% on onboarding.

## 7j. Release Engineering & Launch-Readiness Checklist *(new in v2)*

**Release:** trunk-based, signed installers (MSI/EXE; DMG), channels (alpha/beta/stable) with staged rollout and one-click rollback via the updater manifest; per-adapter feature flags; release notes generated from changelog; compatibility matrix regenerated per release.

**Launch gate (all must be green for MVP):**
- [ ] ≥ 80% acceptance in the Phase 1 exit test; schema-valid rate ≥ 99% after retries
- [ ] Signed + notarized installers; updater tested including rollback
- [ ] Entitlement + billing flow tested end-to-end (purchase, renew, cancel, refund, offline grace)
- [ ] Processor package, privacy policy, ToS, client-agreement template reviewed by counsel
- [ ] Threat model (§7k) mitigations implemented; dependency/licence scan clean
- [ ] Diagnostics, status page, support inbox and KB staffed
- [ ] Telemetry opt-in verified to carry no image content
- [ ] Beta with ≥ 10 photographers, ≥ 3 full real events processed
- [ ] Pricing page, onboarding emails, docs and demo video ready

**Success metrics:** activation (first batch finished within 24 h), recipe acceptance rate, time-to-delivery vs the photographer's prior baseline, weekly active batches, 30/90-day retention, support tickets per 100 batches, gross margin after MoR fees.

## 7k. Threat Model, Compliance Operations & Open-Source Licensing *(new in v2)*

**Threat model (STRIDE summary):**

| Threat | Mitigation |
|---|---|
| Local loopback IPC hijack by another process | 127.0.0.1 bind, per-session token, origin check, token file ACL'd to the user |
| Prompt injection via image text/EXIF causing unsafe recipe | LLM output is data only; strict schema + value clamping; no tool/filesystem access for LLM |
| Malicious RAW/video exploiting decoders | Decode in a separate low-privilege process; keep LibRaw/FFmpeg patched; fuzz inputs in CI |
| API-key theft | OS keychain only; keys never sent to our cloud in BYO mode; redact from logs |
| Update-channel compromise | Signed updater manifests, offline key custody, key rotation procedure |
| License tampering / sharing | Signed entitlements, device cap, server-side revocation; accept some offline-piracy loss |
| Cloud data breach (galleries) | Encryption at rest/in transit, per-tenant prefixes, short-lived pre-signed URLs, retention auto-delete, access logging |
| Image leakage to LLM beyond user intent | Preview-only default, GPS-stripped EXIF, visible "what leaves your device" indicator, per-job opt-in for full-res |

**Compliance operations:** processor package (§3) maintained; sub-processor list published with change notice; breach-response runbook (72-hour GDPR clock); deletion SLA (e.g., 30 days, with provider-side retention disclosed); annual security review; SOC 2 readiness assessment before enterprise/studio sales.

**Open-source licensing policy:** no GPL code linked into the closed-source app; darktable/RawTherapee are **user-installed and invoked as separate processes** (v1 does not bundle them; any later bundling requires a source offer and counsel sign-off); LibRaw via CDDL or dynamic LGPL; maintain a `NOTICE` file and run an automated licence scan (e.g., cargo-deny, license-checker) in CI. ExifTool, rawpy, dcraw, dlib weights and `keyring` licences are UNVERIFIED — read before shipping.

---

## 8. Open Questions (ranked by impact)

1. **Is the local-only execution model (vs. a cloud render farm) acceptable to your target customers and investors?** This is the single biggest pivot from the original "instant cloud editing" vision — resolve by validating with 5–10 target photographers before further build-out.
2. **Will you pursue an Adobe Enterprise/Firefly Services contract** to unlock server-side Photoshop API editing? Verified: Lightroom API and Photoshop API v1 are already EOL (2026-07-31); only Photoshop API v2 remains, Enterprise-gated, with no self-serve path. Resolve by an Adobe sales/partner enquiry.
3. **Is DaVinci Resolve's free edition scriptable externally?** UNVERIFIED — test on a clean install; until then treat Resolve as Studio-only.
4. **Capture One on Windows:** no official automation found; treat as Mac-only unless Capture One support says otherwise. Still read the EULA.
5. **How much manual correction will photographers actually tolerate** before the "AI-edited" value proposition breaks down? Resolve via the Phase 0 acceptance-rate spike.
6. **Do you offer a bundled-LLM-credits tier, or BYO-key only at launch?** Affects onboarding friction vs. margin exposure — decide based on early user interviews (technical vs. non-technical photographers).
7. **Legal: does your subscription ToS and the photographer's client agreements adequately cover AI processing of event imagery containing minors?** Resolve with counsel; include the official DPDP Act/Rules text (not yet retrieved).
8. **Does Adobe's §6.4 "on behalf of any third party" language prohibit a local agent that drives the user's own Lightroom/Premiere?** Counsel opinion before any Adobe-facing code ships.
9. **Which legal entity and country will sell the product?** Drives signing options (Artifact Signing excludes India), MoR eligibility and tax.
10. **Pricing:** what will photographers pay vs. flat competitor plans ($8–$60/mo)? Validate in interviews.

---

## First 30 Days — Action Checklist

- [ ] Download and read the official Lightroom Classic Lua SDK docs (login-gated; needed for the UNVERIFIED API items).
- [ ] Clean-install test of Resolve Free external scripting; read Capture One/DxO/ON1 EULAs.
- [ ] Counsel review: Adobe General Terms §6.4/§6.6 + Developer Terms, official DPDP text, GPL bundling policy, client-agreement AI/minors clause.
- [ ] Choose legal entity, signing path (CA/Developer ID) and merchant of record; set up updater key custody.
- [ ] Build the Phase 0 spike: LLM → Edit Recipe → darktable-cli apply → photographer acceptance test on a real RAW set (target ≥70% acceptance).
- [ ] Draft the Edit Recipe JSON Schema into a shared package with TypeScript codegen and the per-provider structured-output conformance test.
- [ ] Stand up the LLM Gateway skeleton with ≥2 providers (one API-based, one local via Ollama) plus the versioned price table.
- [ ] Interview 5–10 target photographers on local execution, turnaround expectations and pricing.
- [ ] Scaffold the repo structure in §7.2 and lock the desktop stack (recommendation: Tauri).
- [ ] Define the SQLite schema (§7b) and the IPC contract (§7c) as code.

---

## Implementation Status *(updated 2026-11-22, 2nd pass)*

TypeScript monorepo (`npm run build`, `npm test`; Node ≥ 22.5 for `node:sqlite`). **38 tests, all passing.** Implemented and tested:

| Plan section | Where | State |
|---|---|---|
| §7.3 Edit Recipe schema | `packages/core/src/recipe` | Done (zod; rejects out-of-range values) |
| §2.2 Adapter interface | `packages/core/src/adapters` | Done (`detect`, `applyRecipe`, `export`) |
| §2.4 LLM gateway, providers, pricing, spend cap | `packages/core/src/llm` | Done: OpenAI-compatible (OpenAI/Ollama/LM Studio/Gemini endpoint) + Anthropic; schema repair ×2; backoff; cost ledger. Per-provider structured-output conformance test still open |
| §2b Style engine, scene clusters, outliers, override learning | `packages/core/src/style` | Done (LLM calls use injected gateway) |
| §2b Culling (blur, near-duplicate) | `packages/core/src/culling` | Done on grayscale buffers. Missing: closed-eye/face detection |
| §2b/§7b Ingest: embedded-preview extraction, 2048px preview, 512px gray, folder scan | `packages/ingest` | Done (pure-TS JPEG-marker walker finds the largest preview inside CR2/CR3/NEF/ARW/RAF/ORF/DNG/RW2; `jpeg-js` BSD-3 decodes). Previews are re-encoded, so EXIF/GPS is stripped. **Not yet verified on real camera files.** EXIF orientation not applied; files with no embedded JPEG (some DNG/lossless-only) fail with `ASSET_UNREADABLE`; LibRaw fallback still open |
| §2.5/§2.8/§7g Job pipeline, resumability, review gate | `packages/core/src/pipeline` | Done (memory + SQLite stores; export only approved items; `exportApproved` needs no LLM deps) |
| §7d Signed entitlements, offline grace | `packages/core/src/licensing` | Done (ed25519); server issuance/billing not built |
| Adobe XMP sidecar adapter | `packages/adapter-xmp` | Done |
| RawTherapee adapter | `packages/adapter-rawtherapee` | Done against a fake runner; PP3 keys beyond `Compensation`/denoising are **unverified** on a real install |
| Agent CLI (`vivah learn / edit / export`) | `packages/cli` | Done: end-to-end folder workflow with providers `mock`, `openai`, `anthropic`, `ollama`, `openai-compatible`; keys from env; stops at the review gate; resumes from `~/.vivahlens/jobs.db`. Interim stand-in for the desktop UI |

**Run it:** `npm run build`, then `node packages/cli/dist/main.js learn --refs <finished-photos> --name Warm --provider mock` and `... edit --folder <raws> --profile warm.profile.json --provider mock`. Use `--provider openai --model <id>` with `OPENAI_API_KEY` for a real model. The `mock` provider is offline and sends nothing.

**Not yet built:** Tauri desktop app/UI (§2.7), cloud API/billing/galleries (§7c–§7e), Lightroom Lua and Premiere UXP plugins, darktable adapter, Resolve/FCP/Capture One adapters, video pipeline (§7f), LibRaw fallback + EXIF orientation, signing/updater (§3), OS-keychain key storage (keys are env-only today), i18n/accessibility (§7i), cost estimate shown before a run (price table exists in core but the CLI has none configured). Phase 0 spikes remain the gate for several of these.

**Suggested next steps:** (1) run `vivah` on a real RAW set with a real model and measure the Phase 0 acceptance rate; (2) Tauri shell around the CLI's `runJob`/`exportApproved` with the review grid; (3) Lightroom Classic Lua plugin + loopback IPC once the SDK is downloaded; (4) darktable adapter.

---

## Change Log
- **2026-11-22 (impl 2)**: Added `@vivahlens/ingest` (RAW/JPEG preview + grayscale extraction) and `@vivahlens/cli` (end-to-end agent workflow); narrowed `exportApproved` to `StageDeps`; updated Implementation Status.
- **2026-11-22 (impl 1)**: Core engine, XMP and RawTherapee adapters implemented (see Implementation Status).
- **2026-11-22 (v2)**: Verified the plan against primary sources ([editor research](docs/research/editor-integration-verification.md), [platform/market research](docs/research/platform-and-market-verification.md)); corrected §1 table (LrC IPC, Adobe cloud EOL, Resolve/Capture One/FCP/Premiere details, GPL policy), §2.1/§2.4/§2.7 (direct desktop→provider image path, extended LLM interface, costs), §2b (culling libraries), §3 (processor package, signing, credentials), §5 (flat competitor pricing, MoR), §6 (new Phase 0 spikes, local-first MVP, deliverable-based phases), and added §7b–§7k (data model, IPC/API, accounts/licensing/billing, delivery, video pipeline, error handling, SLOs, accessibility/i18n, release/launch gate, threat model/licensing).
