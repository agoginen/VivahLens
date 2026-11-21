# Editor Integration Verification (primary-source check of ARCHITECTURE_AND_PLAN.md §1 / §8)

Research date: 2026-11-22. Method: vendor docs, vendor help-center APIs, license texts and open-source code only. Every claim carries its URL. `UNVERIFIED` = not stated in a retrievable primary source (what was tried is listed). Items marked **[OSS usage]** come from third-party open-source code that exercises the vendor API: it proves the call works, not that it is documented or supported. This is not legal advice.

Access limits met: Adobe Lightroom Classic SDK download is login-gated (Developer Console); Blackmagic forum and Capture One support HTML return 403; `web.archive.org`, `raw.githubusercontent.com`, and direct shell `curl` to most hosts were unreachable. Workarounds used: Zendesk help-center JSON API (`/api/v2/help_center/articles/search.json`), jsDelivr GitHub mirror, Apple `tutorials/data/*.json`.

---

## 1. Lightroom Classic (Lua SDK)

**Answer**
- **Persistent background plugin + external agent: yes (works in practice).** A plugin can start an async task, open `LrSocket` sockets, launch an external app with `LrShell`, and push develop values via `LrDevelopController`. Proven by MIDI2LR (GPL-3.0).
- **IPC options.** Verified: `LrSocket` (two sockets, `mode='send'` and `mode='receive'`, fixed localhost ports, reconnect on error) and `LrHttp` as an HTTP *client* (`LrHttp.post`). **UNVERIFIED:** an `LrHttp` *listener*, and file polling. `LrFileUtils` is used for temp dirs, but no polling example was read.
- **Develop API.** Verified **[OSS usage]**: `LrDevelopController.getValue/setValue/setAutoTone/resetToDefault`, `photo:getDevelopSettings()`, `.lrtemplate` presets, `LrApplicationView.switchToModule('develop')`. **UNVERIFIED:** `photo:applyDevelopPresetAsync` and `photo:applyDevelopSettings` (not in any source read; SDK reference is login-gated).
- **Performance caveats seen in code.** `setValue` needs the Develop module active and acts on the target photo. MIDI2LR calls `LrTasks.yield()` after switching module "to allow module change before value sent" and rate-limits observers to 0.1 s. Catalog writes need `catalog:withWriteAccessDo` (with timeout). Throughput for 500+ photos is untested.
- **Previews/export: yes.** `LrExportSession` + `rendition:waitForRender()` renders a resized JPEG; `LrHttp.post` then sends it to an LLM API **[OSS usage]**.
- **XMP read/write, `catalog:addPhoto`: UNVERIFIED.** `photo:setRawMetadata` inside `withWriteAccessDo` is verified **[OSS usage]**.
- **Develop keys seen in code:** `SplitToningShadowHue/Saturation`, `SplitToningHighlightHue/Saturation`, `ColorGradeShadow/Midtone/Global/HighlightLum|Hue|Sat`, `CropTop/Bottom/Left/Right`, `CropConstrainToWarp`, `AutoLateralCA`, `ConvertToGrayscale`; local-adjustment keys (`exposure2012`, `temperature`, `tint`, `contrast2012`, `highlights2012`, `shadows2012`, `whites2012`, `blacks2012`, `clarity2012`, `dehaze`, `texture`, `saturation`, `hue`, `sharpness`, `maincurve/redcurve/greencurve/bluecurve`, `pointColors`). **UNVERIFIED in vendor docs:** global `Exposure2012`, `Temperature`, `ToneCurvePV2012`, HSL keys (`HueAdjustmentRed` etc.), `CropAngle`. A process-version (PV) constant is tracked (`LatestPVSupported = 6`), so keys vary by PV.

**Evidence**
- Vendor overview (Lua plug-ins; export/publish, metadata, UI; SDK via Developer Console): https://developer.adobe.com/lightroom-classic/
- MIDI2LR `Client.lua` (`LrTasks.startAsyncTask`, `LrSocket.bind` send/receive ports 58764/58763, `LrShell.openFilesInApp` launching `MIDI2LR.exe`, `LrDevelopController` calls, `switchToModule`/`yield`, 0.1 s refresh): https://cdn.jsdelivr.net/gh/rsjaffe/MIDI2LR@develop/src/plugin/Client.lua (repo/licence: https://github.com/rsjaffe/MIDI2LR)
- MIDI2LR `Database.lua` (`getTargetPhoto():getDevelopSettings()`, PV handling) and `LocalPresets.lua` (local keys, `.lrtemplate`): https://cdn.jsdelivr.net/gh/rsjaffe/MIDI2LR@develop/src/plugin/Database.lua , https://cdn.jsdelivr.net/gh/rsjaffe/MIDI2LR@develop/src/plugin/LocalPresets.lua
- `LrExportSession`, `LrHttp.post`, `LrTasks.sleep`, `withWriteAccessDo`, `setRawMetadata`: https://cdn.jsdelivr.net/gh/gesteves/lightroom-alt-text-plugin@main/lightroomalttextplugin.lrplugin/AltTextGenerator.lua
- Tried and failed for the SDK guide/reference: `developer.adobe.com/console/*` (login), legacy `wwwimages2.adobe.com/.../lr6/lightroom-sdk-guide.pdf` (404), `developer.adobe.com/lightroom-classic/docs|guides/` (404), Wayback (unreachable).

**Impact on plan**
- Validates the "local plugin + local agent over `LrSocket`" design and the LLM-on-preview loop (export a small JPEG via `LrExportSession`).
- Plan §1 row "Lightroom Classic" should say develop writes go through the active Develop module, so batch throughput is the Phase-0 spike to measure. The SDK PDF/reference must still be downloaded (checklist item stays open), especially to confirm `applyDevelopSettings`, XMP and `addPhoto`.
- Design the agent to be the socket peer, with a reconnect loop.

---

## 2. DaVinci Resolve

**Answer**
- **Free edition + external scripting: UNVERIFIED.** The vendor README contains mixed signals (below); the Studio page lists "remote scripting API" as a Studio feature. Do not assume free works until tested on a clean free install.
- **Headless (`-nogui`): documented; scripting API keeps working.** Resolve must be running.
- **Functions:** `Graph.SetLUT(nodeIndex, lutPath)`, `TimelineItem.SetCDL({NodeIndex,Slope,Offset,Power,Saturation})`, `Graph.ApplyGradeFromDRX(path, gradeMode 0|1|2)`, `TimelineItem.CopyGrades`, `ExportLUT`, `MediaPool.ImportTimelineFromFile` (AAF/EDL/XML/FCPXML/DRT/ADL/OTIO), `ImportMedia`, `GalleryStillAlbum.ImportStills/ExportStills` (incl. `drx`).
- **Caveats:** nodeIndex is 1-based; `SetLUT` only succeeds for LUT paths Resolve already discovered (`Project.RefreshLUTList`); no `SetCDL`-style per-photo "Photo page" calls were seen.
- **New:** Resolve 21 adds a **Photo page** (`OpenPage("photo")` exists in the API). Photo-specific scripting is UNVERIFIED.
- **Docs location:** the `README.txt` shipped with the app (below).

**Evidence (quotes are from the vendor `README.txt`, read via an unmodified public mirror; the vendor file is installed with Resolve)**
- "In this package, you will find a brief introduction to the Scripting API for DaVinci Resolve Studio."
- "By default, scripts can be invoked from the Console window in the Fusion page, or via command line. This permission can be changed in Resolve Preferences, to be only from Console, or to be invoked from the local network."
- "DaVinci Resolve can be launched in a headless mode without the user interface using the -nogui command line option... the various scripting APIs will continue to work as expected."
- "The DaVinci Resolve scripting APIs cover a common superset of functions for both the Free and Studio versions... API calls can return with a False status... when the function references a Studio function from the free DaVinci Resolve version."
- Mirror (README "Last Updated: 24 Jul 2026", Doc v21.0.4; mirror owner states it is an unmodified copy): https://gist.github.com/X-Raym/2f2bf453fc481b9cca624d7ca0e19de8
- README paths: Windows `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\README.txt`; macOS `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/README.txt` (same gist).
- Studio page: "DaVinci Resolve Studio features support for both Python and LUA scripting, along with developer APIs..." and "remote scripting API" in the Studio feature list: https://www.blackmagicdesign.com/products/davinciresolve/studio
- Resolve 21 / Photo page: https://www.blackmagicdesign.com/products/davinciresolve
- Tried: `forum.blackmagicdesign.com` staff statements (403); `blackmagicdesign.com/developer/...` (404).

**Impact on plan**
- Resolve stays "Green (Studio)" for server-side use; mark free-edition external scripting **UNVERIFIED -> test**, which is the closing action for Open Question 3.
- Add Resolve 21's Photo page as a possible photographer-facing target (re-check in Phase 4).
- LUT/CDL/DRX map cleanly from the Edit Recipe; `.cube` LUTs must be pre-registered.

---

## 3. Capture One

**Answer**
- **Windows automation: UNVERIFIED / none found.** The official help-center article describes macOS only ("Capture One for macOS supports AppleScript... also compatible with JavaScript for Automation (JXA)"). No Windows scripting/SDK article surfaced.
- **AppleScript scope (Mac):** dictionary opened via Scripts -> Open Scripting Dictionary; scripts can run from outside the app. Documented recent additions: 16.7.3 "updated AppleScript automation"; 16.8 `color editor settings` (basic/advanced color corrections); 16.8.2 subject/background/people masks with per-layer adjustments; 16.9.1 `ai crop` in Next Capture Adjustments. Support "does not provide debugging assistance for AppleScript". The plan's "83 adjustment properties" is UNVERIFIED (dictionary is local to the app).
- **`.costyle`:** the support article says the format "can be copied to other computers and between platforms"; **no format specification was found** (UNVERIFIED docs).
- **EULA automation clauses: UNVERIFIED.** `https://www.captureone.com/en/legal` redirects to a JS-rendered Terms page with no extractable EULA text; guessed EULA URLs 404; help-center search "EULA" returned 0 results.

**Evidence**
- AppleScript article (updated 2026-11-18): https://support.captureone.com/hc/en-us/articles/360002681418-Capture-One-Workflow-Automation-with-AppleScript (read via https://support.captureone.com/api/v2/help_center/articles/search.json?query=applescript)
- Styles article: https://support.captureone.com/hc/en-us/articles/360002619518-Saving-a-Custom-Style
- 16.7.3 release notes: https://support.captureone.com/hc/en-us/articles/33550967023389-Capture-One-16-7-3-release-notes
- Terms page (no EULA text retrievable): https://www.captureone.com/en/terms-conditions

**Impact on plan**
- Keep "Mac-only automation; Windows = manual style import". Update the Capture One row's EULA cell to "not retrievable; obtain EULA PDF from the installer/Capture One legal contact". Check EULA before building.
- Mask/color-editor AppleScript support makes Capture One a richer Mac target than assumed (people/subject masks).

---

## 4. Adobe terms, plugin distribution, Premiere UXP

**Answer**
- **General Terms of Use (published and effective Oct 3, 2025)** keep the plan's section numbering. Verbatim:
  - §3.1: "Each license is to be used by only one (1) person and cannot be shared."
  - §6.2: you must not "copy, modify, host, stream, sublicense, or resell the Services and Software".
  - §6.4: you must not "offer, use, or permit the use of or access to the Services and Software in a computer services business, third-party outsourcing service, on a membership or subscription basis, on a service bureau basis, on a time-sharing basis, as a part of a hosted service, or on behalf of any third party".
  - §6.6: you must not "access or attempt to access the Services and Software by any means other than the interface we provide or authorize".
  - §6.7: you must not "circumvent any access or use restrictions".
  - **Ambiguity for the product:** a photographer using their own license on their own machine to edit clients' photos is not clearly "on behalf of any third party"; an agent that drives LrC/Premiere through the Adobe plugin APIs is arguably an "interface we provide". Needs counsel.
- **Adobe Developer Terms of Use (version at `go/developer-terms`: last updated June 18, 2024)** govern developer.adobe.com, Adobe Exchange and "Developer Tools". Relevant clauses:
  - §5.1: Adobe "may restrict distribution of any Developer Software (or access to Adobe Software and Adobe Services by Developer Software) not approved by us"; may require re-approval for updates; may withdraw approval at any time.
  - §5.2: "may require you to distribute approved Developer Software only through Adobe Exchange... or other channels approved by us".
  - §6.2 no interference with Adobe Software.
  - §6.6 you may not combine Developer Tools with other software "in a way that would require the Developer Tools or any other Adobe Services or Software to be... disclosed or distributed in source code form" (GPL/AGPL/LGPL named).
  - §6.9 no software that "does not add significant functionality... beyond a Developer Tool or an API".
  - §6.10 privacy notice and deletion on request.
  - §8.2(D) no Adobe product names or similar names "in the name or product icon of your Developer Software" (a "Lightroom ..." product name is not allowed).
- **Distribution channels.** Adobe Developer Distribution lists **UXP and ZXP** plugin marketplace submissions only; Lua Lightroom Classic plugins are not listed (LrC distribution channel/review: **UNVERIFIED**). Premiere UXP docs: Creative Cloud Marketplace requires "review and approval" (free or paid); Direct Distribution needs "no review or approval" (own website/GitHub/third-party store), packaged as `.ccx`.
- **Premiere UXP status.** Premiere v27.0.0 ships UXP 9.4; breaking change: `Application` class removed from the `premierepro` module. UXP supported from Premiere 25.6.
- **Premiere scripting capabilities (documented):**
  - Project: `createProject/open/createSequence/createSequenceFromMedia`, `executeTransaction` (undoable).
  - `SequenceEditor`: insert/overwrite/clone/remove actions, MOGRT insert.
  - Effects: `VideoFilterFactory.createComponent(matchName)` (25.6) plus `ComponentParam.createKeyframe`. **Lumetri-specific API: UNVERIFIED** (no Lumetri page found).
  - Export: `EncoderManager.exportSequence` (`IMMEDIATELY` / `QUEUE_TO_AME`), `encodeFile`, `startBatchEncode` (26.3), render events; `Exporter.exportSequenceFrame` (bmp, dpx, gif, jpg, exr, png, tga, tif).
  - Panels give a persistent UI; UXP JS API includes file system, networking, shell execution (summary line on landing page).
- **ExtendScript "still supported": UNVERIFIED** (docs only call it the predecessor).

**Evidence**
- General Terms: https://www.adobe.com/legal/terms-linkfree.html
- Developer Terms (PDF): https://www.adobe.com/go/developer-terms (redirects to https://wwwimages2.adobe.com/content/dam/cc/en/legal/servicetou/Developer-Terms-en_US-20240618.pdf)
- Developer Distribution: https://developer.adobe.com/developer-distribution/
- UXP distribution: https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/overview/
- Changelog (v27.0.0, UXP 9.4, `Application` removed; 25.6 baseline): https://developer.adobe.com/premiere-pro/uxp/changelog/ , https://developer.adobe.com/premiere-pro/uxp/introduction/
- Classes: https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/project , .../sequenceeditor , .../encodermanager , .../exporter , .../videofilterfactory
- UXP landing page: https://developer.adobe.com/premiere-pro/uxp/

**Impact on plan**
- Section numbers in plan §1 are confirmed, but quote §6.4 in full and flag the "on behalf of any third party" ambiguity as a legal-review item before launch.
- Add Developer Terms constraints: product naming (no "Lightroom"/"Premiere" in the name), §6.6 vs GPL components in anything that bundles Adobe SDK files, and §5.1 approval/withdrawal risk (prefer direct distribution; do not rely on Exchange).
- Premiere: UXP plugin can assemble sequences and export through AME; treat Lumetri control as a Phase-2 spike (via generic effect components) and pin tests to Premiere 27.x.

---

## 5. darktable and RawTherapee

**Answer**
- **Versions (today):** darktable **5.6.2** (stable bug-fix, released 04 Oct 2026; nightlies also exist). RawTherapee **5.13** (released 26 Jul 2026).
- **`darktable-cli` (5.6 manual):** `darktable-cli [<input file or folder>] [<xmp file>] <output> [--width] [--height] [--hq] [--upscale] [--style <name>] [--style-overwrite] [--apply-custom-presets <0|1|false|true>] [--out-ext] [--import <file or dir>] [--library <path>] [--icc-type|--icc-file|--icc-intent] [--verbose] [--core <darktable options>]`. The dev manual adds `--pq-peak` and `--print-paths`. Runs "without launching a GUI... useful for servers running background jobs".
  - `--style` requires the config dir via `--core --configdir <dir>`; `--style-overwrite` replaces the history stack instead of appending.
  - `--apply-custom-presets 0` skips `data.db`, which allows multiple parallel `darktable-cli` instances but disables `--style`.
  - The optional positional `<xmp file>` supplies the history stack; `--library` reads history from a library DB instead of XMP.
- **Caveats (documented):** after import, "database entries take precedence over the XMP file"; later external XMP edits are overwritten on the next sync. Lightroom XMP import is partial (crop, exposure/black level, vignette, clarity, tone curve, HSL, split toning, grain, spot removal; "never identical results"). Upgrade note: after moving from 5.4, the new library/config "will no longer be usable with 5.4". The per-module-version dependence of XMP history blobs is **UNVERIFIED** here (source not inspected).
- **Lua:** darktable has an embedded Lua API (manual sections: version, darktable, types, events, attributes).
- **RawTherapee CLI (`rtgui/main-cli.cc` usage text, 5.13):** `-c <files|dirs>` (must be last), `-o <file|dir>`, `-O <file|dir>` (also copies the `.pp3`), `-q`, `-a`, `-s` (use sidecar `.pp3`; neutral if missing), `-S` (skip if no sidecar), `-p <file.pp3>` (repeatable; each layer builds on the previous), `-d` (default profile), `-j[1-100]`, `-js<1-3>`, `-t[z]`, `-b<8|16|16f|32>`, `-n`, `-Y`, `-f`.
- **Licence:** both are GPL-3.0-or-later (source headers: "either version 3 of the License, or (at your option) any later version").
- **Implications for a closed-source app:**
  - GPLv3 §5: an "aggregate" of separate, independent works "does not cause this License to apply to the other parts of the aggregate" unless the compilation limits users' rights.
  - GPL FAQ: using fork/exec with command-line arguments and no intimate data-structure sharing leaves the programs separate; "intimate communication by sharing complex data structures" or shared memory/dynamic linking can create a single combined work.
  - Therefore: spawn `darktable-cli`/`rawtherapee-cli` as separate processes and exchange only files (XMP/PP3/images). Do not link `libdarktable`/`rtengine`.
  - If you redistribute the binaries, you are conveying GPL object code and must comply with GPLv3 §6 (Corresponding Source, licence text, notices). Simplest path: have the user install upstream builds, or ship unmodified upstream installers with a source offer.

**Evidence**
- darktable-cli (stable 5.6): https://docs.darktable.org/usermanual/5.6/en/special-topics/program-invocation/darktable-cli/ ; dev: https://docs.darktable.org/usermanual/development/en/special-topics/program-invocation/darktable-cli/
- Release 5.6.2: https://github.com/darktable-org/darktable/releases/tag/release-5.6.2
- Sidecar/DB precedence: https://docs.darktable.org/usermanual/5.6/en/overview/sidecar-files/sidecar/ ; Lightroom import: https://docs.darktable.org/usermanual/5.6/en/overview/sidecar-files/sidecar-import/
- Lua API manual: https://docs.darktable.org/lua/stable/lua.api.manual/
- RawTherapee releases: https://rawtherapee.com/downloads/ , https://rawtherapee.com/downloads/5.13/
- RawTherapee CLI source/usage and GPL header: https://cdn.jsdelivr.net/gh/RawTherapee/RawTherapee@5.13/rtgui/main-cli.cc
- darktable GPL header: https://cdn.jsdelivr.net/gh/darktable-org/darktable@release-5.6.2/src/cli/main.c
- GPLv3 text (§5, §6): https://www.gnu.org/licenses/gpl-3.0.txt ; GPL FAQ "When is a program and its plug-ins considered a single combined program?": https://www.gnu.org/licenses/gpl-faq.html
- Tried: `rawpedia.rawtherapee.com/Command-Line_Options` (404); RawPedia not retrievable, so the usage text in source was used.

**Impact on plan**
- Keep darktable/RawTherapee Green; pin tested versions (darktable 5.6.x, RawTherapee 5.13) and record the XMP/PP3 module-version risk as "test per release".
- Add: generate styles/XMP per run into an isolated `--configdir`; prefer `--apply-custom-presets 0` + XMP for parallel batch workers (no `--style`).
- Add a legal note: process-isolation architecture; bundle only unmodified upstream installers with licence + source offer; counsel review.

---

## 6. Final Cut Pro (FCPXML, Workflow Extensions)

**Answer**
- **FCPXML version:** Apple's published reference states the DTD is **FCPXML 1.10** ("FCP XML Interchange Format, Version 1.10", copyright 2011-2021) and notes 1.9 behaviour. **Newest FCPXML version: UNVERIFIED** (the Apple support page for DTD downloads returned HTTP 429). Verify against the installed FCP's DTD.
- **Colour/effects carried:** `filter-video` references an `effect` resource and "describe[s] color correction, as well as color matching and color balance effects": Color Board, Color Curves, Color Wheels, Hue/Saturation Curves (since FCP 10.4), plus `filter-video-mask` (inside/outside masks). Also ratings, keywords, markers, metadata. Not carried: Apple says FCPXML "describes certain, but not all, aspects of projects and events... it's not a substitute for a native Final Cut Pro project... library bundle". LUT/camera-LUT support: UNVERIFIED.
- **Workflow Extensions:** a macOS container app delivers the extension; FCP hosts it "inside a floating window"; the SDK libraries let it interact with the FCP timeline and collaborate in real time. User-launched and sized for small tasks. It is **not** a headless automation path.
- FCP is Mac-only; import still needs the FCP app running.

**Evidence**
- https://developer.apple.com/documentation/professional_video_applications/fcpxml_reference (read via https://developer.apple.com/tutorials/data/documentation/Professional-Video-Applications/fcpxml-reference.json)
- DTD page (v1.10): https://developer.apple.com/tutorials/data/documentation/Professional-Video-Applications/document-type-definition.json
- `filter-video`: https://developer.apple.com/tutorials/data/documentation/Professional-Video-Applications/filter-video.json
- Workflow Extensions: https://developer.apple.com/tutorials/data/documentation/Professional-Video-Applications/workflow-extensions.json
- Tried: https://support.apple.com/final-cut-pro (429).

**Impact on plan**
- Replace "FCPXML versioned (1.9, 1.10...)" with "Apple's docs publish 1.10; target the DTD of the user's installed FCP version".
- FCP adapter = generate FCPXML (cuts + `filter-video` colour effects) for the user to import; Workflow Extension is an optional Phase-4 UX nicety, not a render path.

---

## 7. DxO PhotoLab and ON1 Photo RAW

**Answer**
- **DxO PhotoLab: no official scripting/SDK/CLI found.** DxO's help center (Zendesk) search returned 0 results for "SDK API", "API", "AppleScript", and "automate batch command"; "scripting" returned 2 hits, the first being Nik CleanupTool instructions (unrelated). This is absence in the support site only; DxO's marketing/product pages were not checked.
- **ON1 Photo RAW: no SDK/CLI found; one post-export hook exists.** Help-center "SDK" returns 0; "scripting" returns 3. The relevant article is "ON1 PHOTO RAW 2022 - How to Run a Script After Export" (updated 2024-08-22): an executable path runs "once for each file that is exported"; output goes to the ON1 log; "ON1 technical support cannot provide support in creating or debugging your scripts." This hooks *after* export; it cannot drive edits.
- ON1's main help site HTML returned 403, so unlisted documentation may exist (UNVERIFIED).

**Evidence**
- DxO: https://support.dxo.com/api/v2/help_center/articles/search.json?query=scripting , ...?query=SDK+API , ...?query=API , ...?query=AppleScript , ...?query=automate+batch+command
- ON1: https://on1help.zendesk.com/hc/en-us/articles/4410320189325-ON1-PHOTO-RAW-2022-How-to-Run-a-Script-After-Export (via https://on1help.zendesk.com/api/v2/help_center/articles/search.json?query=scripting ; `query=SDK` returns 0)

**Impact on plan**
- Keep both Red/omitted; wording becomes "no official automation found in vendor support sites as of 2026-11-22". Optional low-effort idea for ON1: use the export hook only as a notification/QA trigger.
- Re-check DxO/ON1 product pages and ask both vendors directly (single email each) before Phase 4.

---

## 8. Lightroom API / Photoshop API (Adobe cloud)

**Answer**
- **Two different Adobe "Lightroom APIs":**
  1. **Lightroom cloud-catalog API** (`developer.adobe.com/lightroom`): "available only to entitled partner applications that have authenticated the customer, and the customer has given their express permission"; partners "must register a new integration" and use OAuth 2.0. It operates on Lightroom (cloud) catalogs, not Lightroom Classic. How a small company becomes "entitled": **UNVERIFIED** (no application process documented on the pages read).
  2. **Firefly Services Lightroom API** (server-to-server edits): **end-of-life July 31, 2026, already past** as of today; Adobe says to migrate to Photoshop API v2.
- **Photoshop API v2:** generally available; v1 also reached EOL on **July 31, 2026**. v2 supports Actions and **UXP scripting** executed server-side, files up to 5 GB, linked smart objects. **Access:** "Work with your Adobe representative to get... An active Enterprise contract with Firefly Services included" plus Developer Console OAuth server-to-server credentials. **A small startup cannot self-serve this per the docs read; the route is an Adobe sales/enterprise agreement.** Pricing/trials: UNVERIFIED.
- Whether Photoshop API v2 can apply Lightroom-style develop settings (sliders, curves, crop, XMP presets): **UNVERIFIED** (OpenAPI JSON `photoshopv2-api.json` and the v1->v2 migration page returned 404). The plan's `/v2/edit` is unconfirmed.

**Evidence**
- Lightroom cloud API getting started: https://developer.adobe.com/lightroom/lightroom-api-docs/getting-started/
- Firefly Services Lightroom API EOL: https://developer.adobe.com/firefly-services/docs/lightroom/ and https://developer.adobe.com/firefly-services/docs/lightroom/getting-started/deprecation-announcement/ (prerequisites: https://developer.adobe.com/firefly-services/docs/lightroom/getting-started/)
- Photoshop API v2 GA + v1 EOL: https://developer.adobe.com/firefly-services/docs/photoshop/getting-started/v2-ga/ ; auth/prerequisites (Enterprise contract): https://developer.adobe.com/firefly-services/docs/photoshop/getting-started/ ; guides: https://developer.adobe.com/firefly-services/docs/photoshop/guides/photoshop-v2/

**Impact on plan**
- Plan §1 row "Lightroom (cloud/CC)": the Firefly Lightroom API is gone (EOL 2026-07-31) and Photoshop API v1 is already EOL (the plan's "EOL 31 Jul 2026" is now past). Server-side Adobe editing = Photoshop API v2 + Enterprise contract only; downgrade to "Phase 3+ / only if an Adobe Enterprise deal materialises".
- Do not plan on Lightroom cloud API for editing without Adobe partner entitlement (Open Question 2 stays open; first action is an Adobe sales/partner enquiry).

---

## Summary of changes recommended to ARCHITECTURE_AND_PLAN.md

- §0/§1 (LrC): keep the local-plugin design and add the verified IPC pattern (`LrSocket` send/receive + `LrShell` launch + `LrHttp` client); mark `applyDevelopSettings`/`applyDevelopPresetAsync`, XMP and `catalog:addPhoto` as UNVERIFIED until the SDK is downloaded; add a Phase-0 spike on develop-write throughput (Develop module must be active; `yield` needed after module switch).
- §1 (Resolve): change the free-edition cell to "UNVERIFIED; README title says Studio; README says API is a common superset; Studio page lists remote scripting"; add Resolve 21 Photo page; note `SetLUT` needs pre-discovered LUT paths; ImportTimelineFromFile formats include FCPXML/OTIO/AAF/EDL/DRT.
- §1 (Capture One): state Windows automation = none found; add 2026 AppleScript capabilities (colour editor, people/subject/background masks, AI crop); `.costyle` = no public spec, cross-platform copyable; EULA still unretrieved (needs the installer EULA); drop "83 properties" unless counted.
- §1 (Adobe terms): quote §6.4 and §6.6 verbatim (General Terms of 2025-10-03), flag the "on behalf of any third party" ambiguity for counsel; add Developer Terms limits (§5.1 approval/withdrawal, §6.6 GPL combination, §6.9, §8.2(D) naming ban).
- §1 (Premiere): update to UXP v27.0.0/UXP 9.4 (Application class removed); document verified capabilities (sequence assembly, AME export, generic effect creation) and mark Lumetri-specific control and ExtendScript status UNVERIFIED; distribution: direct (no review) or Marketplace (review).
- §1 (darktable/RawTherapee): pin versions (darktable 5.6.2, RawTherapee 5.13); add `darktable-cli` flags (`--style` needs `--core --configdir`; `--apply-custom-presets 0` for parallel runs) and the DB-over-XMP precedence caveat; add RawTherapee CLI flags (`-p` layering, `-s/-S`, `-c` last); add the GPL process-isolation/bundling policy.
- §1 (FCP): FCPXML published reference is 1.10 (latest unverified); colour via `filter-video` (Color Board/Curves/Wheels/HueSat) and masks; Workflow Extensions are a UI integration, not headless.
- §1 (DxO/ON1): keep Red, rephrase as "none found in vendor support sites"; note ON1's post-export script hook.
- §1/§8 (Adobe cloud): Firefly Lightroom API EOL 2026-07-31 and Photoshop API v1 EOL 2026-07-31 (both past); only Photoshop API v2 remains and requires an Enterprise/Firefly Services contract; v2 develop-settings support unconfirmed; Lightroom cloud API needs "entitled partner" status with no documented sign-up.
- §8: Q3 -> "free-edition external scripting unverified, test on clean install"; Q4 -> "no official Windows Capture One automation found"; Q2 -> "start with Adobe sales/partner enquiry; no self-serve path documented".
- "Gaps" list: remove items now answered (Resolve README read; Photoshop API gating confirmed); keep open: LrC SDK reference, Capture One EULA, DxO/ON1 product-page check, latest FCPXML version, Premiere Lumetri API, Resolve free external scripting test.
