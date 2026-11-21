# VivahLens

AI-assisted editing for event photographers (weddings, birthdays, corporate). VivahLens learns a photographer's style, proposes edits for a whole shoot, and applies them through the editing software the photographer already owns. It stops at a human review step before anything is exported.

> **Status: pre-alpha.** The local engine, a command-line tool and a local review UI work and are tested. There is no desktop app, cloud service, or billing yet. See [ARCHITECTURE_AND_PLAN.md](ARCHITECTURE_AND_PLAN.md) for the full plan and an honest gap list.

## How it works

1. **Learn a style** from finished photos (LLM) or, better, from your own Lightroom edits (exact numbers, no LLM).
2. **Edit a folder:** read RAW previews, cull blurry frames and duplicates, group photos by lighting, ask an LLM for a per-photo recipe, and apply it through an adapter (XMP sidecars for Lightroom/Camera Raw, RawTherapee, or the Lightroom Classic plugin).
3. **Review** in a local web UI: adjust sliders, approve, export. Your corrections feed back into the style.

Originals are never modified or uploaded. Only downscaled JPEG previews (EXIF and GPS stripped) are sent to the LLM you choose, with your own key, or to a local model.

## Quick start

Requires **Node 22.13 or newer**.

```powershell
npm install
npm run build

# offline demo: the "mock" provider sends nothing anywhere
node packages/cli/dist/main.js learn --refs <finished-photos> --name Warm --provider mock
node packages/cli/dist/main.js edit  --folder <raw-folder> --profile warm.profile.json --provider mock
node packages/cli/dist/main.js review --folder <raw-folder> --profile warm.profile.json
node packages/cli/dist/main.js stats --folder <raw-folder>
```

Use a real model with `--provider openai|anthropic|gemini|ollama|openai-compatible --model <id>` and the matching key in `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `VIVAH_API_KEY`. Pass `--prices prices.json --max-cost 5` to see an estimate before anything is sent and to refuse to start above a cap.

### Measure whether it is good enough

`vivah eval` replays the LLM on photos that already have *your own* `.xmp` edits and reports how often it lands within tolerance. The plan's Phase 0 target is at least 70%.

```powershell
node packages/cli/dist/main.js learn --from-xmp <folder-with-your-xmp-edits> --name Mine
node packages/cli/dist/main.js eval  --folder <folder-with-raws-and-xmp> --profile mine.profile.json --provider openai --model <id>
```

## Commands

| Command | Purpose |
|---|---|
| `learn` | Learn a style from reference photos (`--refs`) or your own XMP edits (`--from-xmp`) |
| `edit` | Cull, propose and apply edits; resumable; stops at review |
| `review` | Local review UI (127.0.0.1, one-time token) |
| `export` | Approve or export from the command line |
| `stats` | Acceptance rate, corrections and culling counts for a job |
| `eval` | Score LLM edits against your own XMP edits |

Run `vivah --help` for every option.

## Packages

| Package | What it is |
|---|---|
| [`@vivahlens/core`](packages/core) | Edit Recipe schema, LLM gateway, style engine, culling, resumable job pipeline, SQLite store, entitlements, evaluation |
| [`@vivahlens/ingest`](packages/ingest) | RAW/JPEG preview extraction, EXIF, orientation, fingerprints |
| [`@vivahlens/adapter-xmp`](packages/adapter-xmp) | Adobe XMP sidecars (Lightroom, Camera Raw) and the XMP edit ingester |
| [`@vivahlens/adapter-rawtherapee`](packages/adapter-rawtherapee) | RawTherapee PP3 profiles + CLI export |
| [`@vivahlens/adapter-lightroom`](packages/lightroom) | Authenticated loopback IPC and adapter for a Lightroom Classic plugin (plugin not written yet) |
| [`@vivahlens/review`](packages/review) | Local review server and UI |
| [`@vivahlens/cli`](packages/cli) | The `vivah` command |
| [`@vivahlens/testkit`](packages/testkit) | Shared adapter contract tests |

## Development

```powershell
npm run build      # typecheck and compile every package
npm test           # all tests
npm run schema     # regenerate packages/core/schema/edit-recipe.schema.json after changing the recipe
npm run licenses   # runtime-dependency licence gate + NOTICE check (--write to regenerate)
npm run ci         # what CI runs
```

CI (`.github/workflows/ci.yml`) runs build, tests and the licence gate on Windows, macOS and Linux with Node 22 and 24.

New editor adapters implement `EditorAdapter` and must pass the shared contract:

```ts
import { adapterContract } from "@vivahlens/testkit";
adapterContract({ name: "my-editor", create, photo });
```

## Documents

- [ARCHITECTURE_AND_PLAN.md](ARCHITECTURE_AND_PLAN.md): architecture, roadmap, risks, implementation status and gap analysis
- [docs/research/](docs/research): source-cited verification of editor APIs, provider policies, pricing and licences

## Licence

No licence has been chosen yet; all rights are reserved until one is added. Third-party notices are in [NOTICE](NOTICE).
