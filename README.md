# VivahLens

AI-assisted editing for event photographers (weddings, birthdays, corporate). VivahLens learns a photographer's style, proposes edits for a whole shoot, and applies them through the editing software the photographer already owns, or with its own built-in renderer. It stops at a human review step before anything is exported.

> **Status: pre-alpha.** The local engine, the command-line tool (also buildable as one executable), the local review UI, five editor routes, delivery finishing, a video rough-cut tool, signed updates and a reference licensing server work and are tested (**1,118 tests, 1,108 passing, 10 skipped by design**). There is no desktop app, hosted gallery or billing integration yet, and **nothing has been run against a real Lightroom Classic, RawTherapee, darktable, Premiere, Resolve, Final Cut Pro, real LLM, macOS or Linux machine**: those routes are tested against fakes and are labelled below. See [ARCHITECTURE_AND_PLAN.md](ARCHITECTURE_AND_PLAN.md) for the plan and an honest gap list.

## How it works

1. **Learn a style** from finished photos (LLM) or, better, from your own Lightroom edits (exact numbers, no LLM).
2. **Edit a folder:** read RAW previews, cull blurry frames and duplicates, group photos by lighting, ask an LLM for a per-photo recipe, and apply it through an adapter (below).
3. **Review** in a local web UI (English and Hindi, keyboard-driven): adjust sliders, see a rendered before/after, approve, export. Your corrections feed back into the style.
4. **Deliver:** finish the exported JPEGs for the client: location data removed, copyright and creator written, optional watermark and size ceiling, optional ZIP. Originals are left alone.
5. **Video:** `vivah cut` builds a highlight-reel timeline (FCPXML or EDL) from a folder of clips for you to open in your editor.

Originals are never modified or uploaded. Only downscaled JPEG previews (EXIF and GPS stripped) are sent to the LLM you choose, with your own key, or to a local model. Every edit can be taken back out of your files with `vivah undo`.

### Editor routes (`--adapter`)

| Adapter | What it does | Verified |
|---|---|---|
| `xmp` (default) | Writes Lightroom / Camera Raw sidecars (`.xmp`), merging into yours | Format tested; never opened in Lightroom |
| `lightroom` | Drives Lightroom Classic through a plugin; `vivah plugin lightroom` installs it | Protocol tested with a Lua interpreter; **never run in Lightroom** (setting names and `applyDevelopSettings` are unconfirmed) |
| `rawtherapee` | Writes PP3 profiles and exports with `rawtherapee-cli` | Against a fake runner; PP3 keys beyond exposure and denoising unconfirmed. Beta |
| `darktable` | Merges exposure and crop into darktable's own sidecar and exports with `darktable-cli` (darktable 5.6 or newer, source-verified layouts) | Against a fake runner and hand-derived blobs. Beta |
| `render` | The built-in renderer draws the recipe onto the photo and writes JPEGs, no editor needed | Tested; an approximation of an editor's look, not a match for any of them |

## Quick start

Requires **Node 22.13 or newer** (or build the single executable below, which needs nothing installed).

```powershell
npm install
npm run build

# offline demo: the "mock" provider sends nothing anywhere
node packages/cli/dist/main.js doctor
node packages/cli/dist/main.js learn --refs <finished-photos> --name Warm --provider mock
node packages/cli/dist/main.js edit  --folder <raw-folder> --profile warm.profile.json --provider mock
node packages/cli/dist/main.js review --folder <raw-folder> --profile warm.profile.json
node packages/cli/dist/main.js stats --folder <raw-folder>
```

`vivah doctor` checks what a first run needs (tools, model keys, licence, plugin) and says how to fix what is missing.

Use a real model with `--provider openai|anthropic|gemini|azure|ollama|openai-compatible --model <id>` and the matching key in `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `VIVAH_API_KEY`. Pass `--prices prices.json --max-cost 5` to see an estimate before anything is sent and to refuse to start above a cap (with `--max-cost`, a model that has no price in the table is refused too, never assumed free).

### One executable

```powershell
npm run build
npm run sea          # builds dist-sea/vivah.exe (vivah on macOS and Linux) and runs it through its paces
```

One file of about 90 MB holds Node, the compiled program, the review page, the Lightroom plugin and the image decoder. **Verified on Windows x64 with Node 24:** the build's own smoke test runs the bare executable from an empty folder and checks that it prints its usage, reports its version, edits photos on decoder workers, serves the review page and every file it uses, installs the Lightroom plugin and leaves nothing behind in the temp folder. It is **unsigned** (sign it with `signtool sign /fd SHA256 /tr <timestamp server> /td SHA256 vivah.exe`). The macOS and Linux steps and the one-step `--build-sea` of Node 25.5+ follow the research in [docs/research](docs/research) but have not been run. `npm run sbom` writes a CycloneDX bill of materials of what the executable needs (`--package @vivahlens/cloud-api` for the licensing server instead).

### Measure whether it is good enough

`vivah eval` replays the LLM on photos that already have *your own* `.xmp` edits and reports how often it lands within tolerance. The plan's Phase 0 target is at least 70%.

```powershell
node packages/cli/dist/main.js learn --from-xmp <folder-with-your-xmp-edits> --name Mine
node packages/cli/dist/main.js eval  --folder <folder-with-raws-and-xmp> --profile mine.profile.json --provider openai --model <id>
```

Add `--perceptual` to also draw your edit and the model's onto the same photo and compare the two pictures (CIEDE2000 colour difference and SSIM, framing left out). Slider values that differ can still give the same look, and this is the measure that sees it. About 1 is the smallest difference a trained eye sees side by side, 2 to 3 shows at a glance, above 5 is plainly different; the report gives the share within 3 and within 6.

## Deliver to the client

Lightroom and the XMP adapter only write edits; you export JPEGs from your editor. `vivah deliver` then finishes those JPEGs into a new folder (the originals are never touched):

```powershell
node packages/cli/dist/main.js deliver --folder <exported-jpegs> --out <client-folder> `
  --copyright "© 2026 Your Studio" --creator "Your Name" --zip
```

- **Location data is removed by default.** The Exif GPS block is erased wherever it can be reached from, and GPS properties are cut out of XMP. Because location can also sit in places this code cannot read, the file is cut down to what it understands (JFIF, Exif, XMP, the colour profile, Adobe's colour flag and IPTC fields): vendor blocks such as GoPro telemetry, comments, extended XMP, the Exif thumbnail and anything after the image (appended images, HDR gain maps, motion-photo video) are dropped, and an Exif block with a corrupt structure is dropped rather than trusted. The command reports what it dropped without inspecting. Pass `--keep-gps` to keep location data. **Not detected:** location inside a camera's proprietary MakerNote, and place names typed into IPTC/XMP fields (city, sublocation).
- **Credit** (`--copyright`, `--creator`) is written to both IPTC and XMP, because readers prefer XMP. The XMP packet is edited in place, so keywords and captions there are kept; Photoshop blocks are reduced to their IPTC fields.
- **Presets** (`--preset web|social|album|print`, or `--max-edge <px> --quality <n>`) set a size ceiling. Files already within it are not re-encoded.
- **Watermark** (`--watermark logo.png`, with `--watermark-position`, `--watermark-opacity`, `--watermark-size`) uses a PNG with transparency.
- **ZIP** (`--zip`) packs the result next to the output folder, split into parts of at most 2048 MB (`--zip-max-mb`).
- **`--notify`** (on `edit` and `deliver`) shows a desktop notification when a long job finishes. Windows uses a fixed PowerShell toast (run for real; whether it shows depends on your notification settings), macOS and Linux use `osascript` and `notify-send` (not run). The text travels as data, never as code, and a notification that cannot be shown never fails the command.

Credit and location removal edit the file's metadata in place and take milliseconds. Resizing and watermarking re-encode the pixels in pure JavaScript on a single thread (about 3–4 s per 24 MP photo): the colour profile is kept but camera metadata is dropped. For big batches, resize in your editor's export and use `deliver` for the metadata. TIFF deliveries are not supported yet, and there is no SFTP or hosted gallery.

The same options work on `export` and `review` when the adapter can export (RawTherapee, darktable, render), applied to each file right after the editor writes it. If a file cannot be finished it is deleted and reported rather than left behind with its location data. A RAW and its camera JPEG are exported as `IMG_001.jpg` and `IMG_001-jpg.jpg` rather than one overwriting the other, and `--export-dir` may not be the folder the photos came from.

## Commands

| Command | Purpose |
|---|---|
| `learn` | Learn a style from reference photos (`--refs`) or your own XMP edits (`--from-xmp`) |
| `edit` | Cull, propose and apply edits; resumable (kill it any time and run it again); stops at review. `--offline` reuses earlier work with no model; `--workers <n>` sets the decoder threads |
| `undo` | Take a job's edits back out of your files |
| `review` | Local review UI (127.0.0.1, one-time token) |
| `export` | Approve or export from the command line |
| `deliver` | Finish exported JPEGs for the client: remove location, add credit, watermark, size ceiling, ZIP |
| `stats`, `privacy` | Acceptance rate and corrections for a job; what has been sent to model providers (counts and sizes only) |
| `eval` | Score LLM edits against your own XMP edits (`--perceptual` also compares the pictures) |
| `cut` | Rough-cut highlight reel from a folder of clips as an FCPXML/EDL timeline (needs ffmpeg; Pro and Studio plans) |
| `activate`, `license`, `deactivate` | Bind this computer to a licence, show its plan and expiry, free the slot |
| `doctor` | Check what VivahLens needs and say how to fix it |
| `plugin lightroom` | Install the VivahLens plugin into Lightroom Classic (Windows and macOS) |
| `diagnostics` | Write a support file with no photos, keys or names in it (folder and photo names are replaced; nothing is sent) |
| `telemetry [on\|off\|status]` | Usage counts to your licence server after each edit. Off unless you turn it on; counts only, never content |
| `update` | Check for a newer version. The answer is signed and verified with pinned keys; nothing is installed |

Run `vivah --help` for every option.

### Licences and what happens when one lapses

A licence is checked when `VIVAH_LICENSE_PUBLIC_KEY` is set (a development build with no key enforces nothing; a shipped build embeds its key). A subscription that lapses never takes your work hostage: after the 14-day offline grace, or as soon as the server says it is inactive, **editing pauses and everything else keeps working**: export, deliver, undo and review stay available. `vivah license` exits non-zero when access is not full. Trials are limited to 50 photos per job (set by the server).

### Environment

| Variable | Meaning |
|---|---|
| `VIVAH_HOME` | Where data lives (jobs database, logs, licence, settings, Lightroom handshake); default `~/.vivahlens` |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `VIVAH_API_KEY` | Model keys |
| `VIVAH_LICENSE_PUBLIC_KEY`, `VIVAH_LICENSE`, `VIVAH_SERVER` | Licence verification key, a static licence token, the licence server |
| `VIVAH_SECRET_STORE=none` | Keep the refresh token in the private file instead of the system's secret store (DPAPI, keychain, Secret Service) |
| `VIVAH_LOG_LEVEL` | `debug`, `info` (default), `warn` or `error`. The log is `logs/vivah.jsonl` in the data folder, rotated, metadata only |
| `VIVAH_UPDATE_KEYS`, `VIVAH_UPDATE_URL` | Pinned public keys (JSON or a file) and the base address for signed updates and settings |
| `DARKTABLE_CLI`, `RAWTHERAPEE_CLI`, `FFMPEG`, `FFPROBE` | Where those programs are, when not on the path |
| `VIVAH_ADMIN_KEY` | The licensing server's admin key, as read by `scripts/signing.mjs publish` (the server itself is given its key when it is started) |

## Performance

Measured on one development machine (Intel i7-1270P, 16 threads, Windows, JPEG previews), reproducible with `node scripts/bench.mjs --photos 30`: **0.39 s per photo with the decoder workers, about 3.2 minutes for 500 photos** (before the workers it was 1.28 s a photo, a miss of the plan's 10-minute target). Start to ready 0.33–0.38 s; first preview p90 0.88 s; the review server idles at 64 MB and about 0% CPU. These are not figures for your hardware or for real RAW files. Resumability is proven with a real `kill -9` of a 1,500-photo job in both stages (`packages/core/src/pipeline/resumability.test.ts`).

## Packages

| Package | What it is |
|---|---|
| [`@vivahlens/core`](packages/core) | Edit Recipe schema, LLM gateway, style engine, culling, resumable job pipeline, SQLite store, entitlements and access, signed documents, logging, secrets, evaluation |
| [`@vivahlens/ingest`](packages/ingest) | RAW/JPEG preview extraction, EXIF, orientation, fingerprints, the decoder worker pool |
| [`@vivahlens/render`](packages/render) | Pure-TypeScript recipe renderer, preview renderer, the `render` adapter, image-difference metrics (CIEDE2000, SSIM) |
| [`@vivahlens/delivery`](packages/delivery) | Finishing exported JPEGs: GPS removal, IPTC/XMP credit, PNG watermark, size ceiling, ZIP |
| [`@vivahlens/video`](packages/video) | Clip analysis, highlight selection, FCPXML/EDL export, ffmpeg wrapper, beat-aligned cuts |
| [`@vivahlens/cloud-api`](packages/cloud-api) | Reference licensing server: activation, signed entitlements, Paddle subscription webhooks, style-profile sync, usage metering, hosted signed documents |
| [`@vivahlens/adapter-xmp`](packages/adapter-xmp) | Adobe XMP sidecars (Lightroom, Camera Raw) and the XMP edit ingester |
| [`@vivahlens/adapter-rawtherapee`](packages/adapter-rawtherapee) | RawTherapee PP3 profiles + CLI export |
| [`@vivahlens/adapter-darktable`](packages/adapter-darktable) | darktable sidecar merge + CLI export |
| [`@vivahlens/adapter-lightroom`](packages/lightroom) | Loopback IPC, the adapter, and the Lightroom Classic plugin (Lua) |
| [`@vivahlens/review`](packages/review) | Local review server and UI |
| [`@vivahlens/cli`](packages/cli) | The `vivah` command |
| [`@vivahlens/testkit`](packages/testkit) | Shared adapter contract tests |

## Development

```powershell
npm run build      # typecheck and compile every package
npm test           # all tests
npm run schema     # regenerate packages/core/schema/edit-recipe.schema.json after changing the recipe
npm run licenses   # runtime-dependency licence gate + NOTICE check (--write to regenerate)
npm run sea        # build and smoke-test the single executable
npm run sbom       # CycloneDX bill of materials of what ships
npm run ci         # what CI runs
```

Runtime dependencies are `jpeg-js` and `zod` only. Some tests run the built program and skip when nothing is built: run `npm run build` first for the full set. After restoring a file during a mutation check, rebuild with `npx tsc -b --force`: restoring an old modification time can leave stale compiled code (this once hid a failure).

Scripts: `scripts/bench.mjs` (SLO benchmark), `scripts/resume-worker.mjs` (kill -9 proof), `scripts/signing.mjs` (keygen, sign, verify and publish a signed release manifest or settings document), `scripts/build-sea.mjs`, `scripts/sbom.mjs`.

CI (`.github/workflows/ci.yml`) runs build, tests, the licence gate and the executable's smoke test on Windows, macOS and Linux. `.github/workflows/release.yml` builds an executable per platform plus checksums and bills of materials into a draft release. **Neither workflow has run on GitHub**, and signing and notarization are not in them (they need your certificates).

A longer fuzz of the location scrubber against an independent reference reader (seeded, so a failure reproduces): `VIVAH_FUZZ_RUNS=200000 VIVAH_FUZZ_SEED=7 npx vitest run packages/delivery/src/scrub.test.ts -t "mutated Exif"`.

New editor adapters implement `EditorAdapter` and must pass the shared contract:

```ts
import { adapterContract } from "@vivahlens/testkit";
adapterContract({ name: "my-editor", create, asset });
```

### Security notes

- `npm audit` reports a high-severity advisory on `zod` (memory use when a large array fails validation; fixed only in zod 4). Every array that arrives from outside now goes through `boundedArray`, which refuses an oversized one before looking inside it; without that, one 256 KB request cost the server about 130 MB. A move to zod 4 is still open.
- `npm audit` also reports advisories in the **test tooling** (vitest, vite, tinypool, a dev-server issue in the nested esbuild). None of it is in what ships (the bill of materials lists `jpeg-js` and `zod` and the VivahLens packages); moving to a current vitest is a major upgrade that is still to do.

## Documents

- [ARCHITECTURE_AND_PLAN.md](ARCHITECTURE_AND_PLAN.md): architecture, roadmap, risks, implementation status and gap analysis
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md): what is protected, from whom, by what (with the test that proves each defence), and what is not covered
- [docs/research/](docs/research): source-cited verification of editor APIs, provider policies, pricing, platform and release facts, and licences

## Licence

No licence has been chosen yet; all rights are reserved until one is added. Third-party notices are in [NOTICE](NOTICE).
