import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { RawTherapeeAdapter } from "@vivahlens/adapter-rawtherapee";
import { DarktableAdapter } from "@vivahlens/adapter-darktable";
import { isGeneratedByVivah, parseCrsToRecipe, readXmpEdits, XmpSidecarAdapter } from "@vivahlens/adapter-xmp";
import { installLightroomPlugin, LIGHTROOM_HANDSHAKE_FILE, LightroomBridge, LightroomClassicAdapter, lightroomModulesDir } from "@vivahlens/adapter-lightroom";
import {
  accessFor,
  assertWithinLimits,
  estimateBatchCost,
  evaluateRecipes,
  exportApproved,
  jobStats,
  learnStyle,
  LlmGateway,
  LOOKS_CLOSE,
  LOOKS_THE_SAME,
  notify,
  profileFromRecipes,
  proposeRecipe,
  removeBridgeHandshake,
  runJob,
  runProcess,
  SqliteStore,
  StyleProfileSchema,
  summarizeOutbound,
  summarizePerceptual,
  undoJob,
  verifyEntitlement,
  VivahError,
  writeBridgeHandshake,
  type AssetRef,
  type Channel,
  type EditorAdapter,
  type EditRecipe,
  type EvalCase,
  type GatewayOptions,
  type ProcessRunner,
  type ReviewSummary,
  type RemoteConfig,
  type Runner,
  type StyleProfile,
  type VersionedPriceTable,
} from "@vivahlens/core";
import { DecodePool, defaultDecodeWorkers, loadPreview, scanFolder } from "@vivahlens/ingest";
import { createPreviewRenderer, RenderAdapter } from "@vivahlens/render";
import { writeZip } from "@vivahlens/delivery";
import { startReviewServer, startStudioServer, FieldError, type ReviewDeps, type ReviewServer, type StartRequest, type StudioWorkflow } from "@vivahlens/review";
import {
  analyzeClip,
  analyzeMusic,
  choosePicks,
  Ffmpeg,
  layoutPicks,
  orderByNarrative,
  parseFps,
  TimelineFileAdapter,
  type MusicTrack,
  type ProbedClip,
} from "@vivahlens/video";
import { AnalysisCache } from "./analysisCache.js";
import { DELIVERY_FLAGS, describeTally, finishTracked, planDelivery, type Delivery } from "./delivery.js";
import { buildDiagnostics } from "./diagnostics.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { describeEntitlement, describeStatus, readPublicKey, requireLicense } from "./license.js";
import { dataDir, sameDirectory } from "./paths.js";
import { scorePerceptually } from "./perceptualEval.js";
import { activate as activateLicense, currentEntitlement, deactivate as deactivateLicense, LicenseStore } from "./licenseClient.js";
import { APP_VERSION, openCommandLog } from "./logging.js";
import { progressPrinter } from "./progress.js";
import { buildGateway, providerNotice, type ProviderChoice } from "./providers.js";
import { adapterNotice, loadRemoteConfig } from "./remoteConfigClient.js";
import { SettingsStore } from "./settings.js";
import { documentServer, installId, pinnedKeys, TrustState } from "./signedClient.js";
import { checkForUpdates, describeUpdate, updateTarget } from "./updates.js";
import { reportUsage, USAGE_FIELDS } from "./usageReport.js";

export interface CliContext {
  env: Record<string, string | undefined>;
  /** Results (summaries, JSON): stdout. */
  log(line: string): void;
  /** Progress, notices and cost lines: stderr, so `--json` output stays machine-readable. Defaults to `log`. */
  info?(line: string): void;
  /** Long-running commands stop when this aborts; the binary wires it to Ctrl-C. */
  signal?: AbortSignal;
  /** Launches external programs (ffmpeg, ffprobe, rawtherapee-cli); tests inject a fake. */
  run?: ProcessRunner;
  /** Launches the program that shows a desktop notification, which takes its text on standard input; tests inject a fake. */
  notifier?: Runner;
  /** Opens the review page in the person's browser. The binary supplies it; tests leave it out so nothing is opened. */
  openUrl?(url: string): Promise<void> | void;
}

const info = (ctx: CliContext, line: string): void => (ctx.info ?? ctx.log)(line);

/** With --notify, tells the person that a long job has finished. A convenience, so failing to show it is only a note. */
async function announceFinished(v: Args, ctx: CliContext, title: string, body: string): Promise<void> {
  if (!v.notify) return;
  const outcome = await notify({ title, body }, { ...(ctx.notifier && { run: ctx.notifier }) });
  if (!outcome.sent) info(ctx, `No notification was shown: ${outcome.reason}`);
}

const USAGE = `vivah: AI editing automation (local-first)

  vivah learn  --refs <dir> --name <style> [--out profile.json]      learn a style from finished photos (LLM)
  vivah learn  --from-xmp <dir> --name <style>                       learn from your own Lightroom edits (exact, no LLM)
  vivah edit   --folder <dir> --profile <file> [--adapter xmp|rawtherapee|darktable|lightroom|render] [--offline]
                                                                    cull, propose and apply edits, then stop for review
                                                                    (--offline: no model; reuses edits already made to the same files)
  vivah undo   (--folder <dir> | --job <id>) [--dry-run] [--force] [--photos a.cr3,b.cr3]
                                                                    take a job's edits back out of your files (sidecars restored)
  vivah review [--folder <dir> --profile <file>] [--export-dir <dir>] [--no-open]
                                                                    open the local review UI in your browser. With no --folder and --profile
                                                                    it opens a page where you choose the photos, the output folder and your
                                                                    style photos, start the edit, then review (default there: --adapter render,
                                                                    and the offline demo model unless you pass --provider)
  vivah export --folder <dir> (--approve a.cr3,b.cr3 | --approve-all) [--export-dir <dir>]
                                                                    approve/export from the command line
  vivah deliver --folder <jpegs> --out <dir> [--preset web|social|album|print] [--zip]
                                                                    finish exported JPEGs for the client: remove location,
                                                                    add credit, watermark, size ceiling (originals untouched)
  vivah stats  (--folder <dir> | --job <id>) [--json]                acceptance rate and corrections for a job
  vivah privacy [--job <id>] [--json]                                what has been sent to model providers (counts and sizes only)
  vivah eval   --folder <dir> --profile <file> [--limit <n>] [--perceptual] [--json]
                                                                    score LLM edits against your own XMP edits (Phase 0 test);
                                                                    --perceptual also draws both edits and compares the pictures
  vivah cut    --folder <clips> [--duration 90] [--timeline fcpxml|edl|both] [--music <file>] [--music-start <sec>] [--music-gain <dB>]
               [--crossfade] [--drop-frame] [--narrative]
                                                                    rough-cut highlight reel as an FCPXML/EDL timeline (needs ffmpeg)
  vivah activate --server <url> --key <license key> [--device-name <name>]   bind this computer to your license
  vivah license                                                     show the plan and expiry of this computer's license
  vivah deactivate                                                  free this computer's license slot
  vivah doctor [--json]                                             check what VivahLens needs (tools, keys, license, plugin) and say how to fix it
  vivah diagnostics [--job <id> | --folder <dir>] [--out <file>]    write a support file with no photos, keys or names in it (nothing is sent)
  vivah telemetry [on|off|status]                                   usage counts to your license server after each edit: off unless you turn it on
  vivah update [--channel stable|beta|alpha] [--server <url>] [--json]
                                                                    check for a newer version (the answer is signed and verified; nothing is installed)
  vivah plugin lightroom                                            install the VivahLens plugin into Lightroom Classic

Common: --provider mock|openai|anthropic|gemini|azure|ollama|openai-compatible  --model <id>  [--base-url <url>]
        (azure: --base-url https://<resource>.openai.azure.com/openai/v1, --model is your deployment name)
        --prices <file>  --max-cost <usd>  --db <file>  --job <id>  --concurrency <n>  --workers <n>  --retry-failed
        --license <file>  --confirm-paid-tier (gemini only)
        --notify (edit, deliver): show a desktop notification when it finishes
Cut:    --name <reel name>  --export-dir <dir>  --fps <rate>  --min-seg <s>  --max-seg <s>  (FFMPEG / FFPROBE override the binaries)
Delivery (export, review, deliver): --preset web|social|album|print  --max-edge <px>  --quality <1-100>
        --copyright "<notice>"  --creator "<name>"  --keep-gps (location data is removed unless you pass this)
        --watermark <logo.png>  --watermark-position bottom-right|bottom-left|top-right|top-left|center
        --watermark-opacity <1-100>  --watermark-size <1-100, % of photo width>
        deliver also takes --zip [--zip-max-mb <n>] to pack the result into ZIP part(s) of at most n MB (default 2048)
Lightroom: --plugin-wait <seconds> (default 60) while the VivahLens plugin connects.
Keys are read from OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / AZURE_OPENAI_API_KEY / VIVAH_API_KEY; RAWTHERAPEE_CLI and DARKTABLE_CLI override the rawtherapee-cli and darktable-cli paths.
Only downscaled JPEG previews (no EXIF/GPS) are sent to the LLM; originals are never modified or uploaded.`;

const MAX_REFERENCES = 10;
/** Heuristic per-photo LLM usage for a ~2048px preview plus prompt, and a recipe reply (see research notes). */
const EST_INPUT_TOKENS = 1600;
const EST_OUTPUT_TOKENS = 400;

const OPTIONS = {
  refs: { type: "string" },
  "from-xmp": { type: "string" },
  name: { type: "string" },
  out: { type: "string" },
  folder: { type: "string" },
  profile: { type: "string" },
  adapter: { type: "string", default: "xmp" },
  db: { type: "string" },
  job: { type: "string" },
  concurrency: { type: "string" },
  workers: { type: "string" },
  limit: { type: "string" },
  duration: { type: "string" },
  timeline: { type: "string", default: "fcpxml" },
  music: { type: "string" },
  "music-start": { type: "string" },
  "music-gain": { type: "string" },
  crossfade: { type: "boolean" },
  "drop-frame": { type: "boolean" },
  narrative: { type: "boolean" },
  fps: { type: "string" },
  "min-seg": { type: "string" },
  "max-seg": { type: "string" },
  json: { type: "boolean" },
  license: { type: "string" },
  server: { type: "string" },
  channel: { type: "string" },
  key: { type: "string" },
  "device-name": { type: "string" },
  "max-cost": { type: "string" },
  prices: { type: "string" },
  "plugin-wait": { type: "string" },
  "retry-failed": { type: "boolean" },
  offline: { type: "boolean" },
  "no-open": { type: "boolean" },
  perceptual: { type: "boolean" },
  notify: { type: "boolean" },
  force: { type: "boolean" },
  "dry-run": { type: "boolean" },
  photos: { type: "string" },
  "confirm-paid-tier": { type: "boolean" },
  provider: { type: "string", default: "openai" },
  model: { type: "string" },
  "base-url": { type: "string" },
  approve: { type: "string" },
  "approve-all": { type: "boolean" },
  "export-dir": { type: "string" },
  format: { type: "string" },
  quality: { type: "string" },
  preset: { type: "string" },
  "max-edge": { type: "string" },
  watermark: { type: "string" },
  "watermark-position": { type: "string" },
  "watermark-opacity": { type: "string" },
  "watermark-size": { type: "string" },
  copyright: { type: "string" },
  creator: { type: "string" },
  "keep-gps": { type: "boolean" },
  zip: { type: "boolean" },
  "zip-max-mb": { type: "string" },
  help: { type: "boolean" },
} as const;

type Args = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

/**
 * `node:util`'s parser refuses `--music-gain -10` (a value that starts with a dash) and asks for `--music-gain=-10`. A
 * negative number is never an option name, so join it to the option before it and the natural spelling works.
 */
export function joinNegativeNumbers(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (const arg of argv) {
    const previous = out[out.length - 1];
    if (previous?.startsWith("--") && !previous.includes("=") && /^-\d+(\.\d+)?$/.test(arg)) out[out.length - 1] = `${previous}=${arg}`;
    else out.push(arg);
  }
  return out;
}

/** Entry point shared by the binary and tests. Returns the process exit code. */
export async function runCli(argv: readonly string[], ctx: CliContext): Promise<number> {
  try {
    const { values, positionals, tokens } = parseArgs({ args: joinNegativeNumbers(argv), options: OPTIONS, allowPositionals: true, tokens: true });
    // Options that have a default (--provider, --adapter) cannot tell "not given" from "given the default"; the page needs to.
    const given = new Set(tokens.flatMap((token) => (token.kind === "option" ? [token.name] : [])));
    const command = positionals[0];
    if (values.help || !command) {
      ctx.log(USAGE);
      return command || values.help ? 0 : 1;
    }
    switch (command) {
      case "learn":
        return await learn(values, ctx);
      case "edit":
        return await edit(values, ctx);
      case "review":
        return await review(values, ctx, given);
      case "export":
        return await exportCmd(values, ctx);
      case "deliver":
        return await deliverCmd(values, ctx);
      case "stats":
        return await stats(values, ctx);
      case "eval":
        return await evalCmd(values, ctx);
      case "cut":
        return await cutCmd(values, ctx);
      case "undo":
        return await undoCmd(values, ctx);
      case "privacy":
        return await privacyCmd(values, ctx);
      case "activate":
        return await activateCmd(values, ctx);
      case "license":
        return await licenseCmd(ctx);
      case "deactivate":
        return await deactivateCmd(ctx);
      case "doctor":
        return await doctorCmd(values, ctx);
      case "diagnostics":
        return await diagnosticsCmd(values, ctx);
      case "telemetry":
        return await telemetryCmd(positionals[1], ctx);
      case "update":
        return await updateCmd(values, ctx);
      case "plugin":
        return await pluginCmd(positionals[1], ctx);
      default:
        ctx.log(`Unknown command "${command}"\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      ctx.log("Cancelled. Progress is saved; run the same command again to resume.");
      return 130;
    }
    ctx.log(`error: ${err instanceof VivahError ? `[${err.code}] ` : ""}${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

const need = (value: string | undefined, flag: string): string => {
  if (!value) throw new Error(`--${flag} is required`);
  return value;
};

function providerChoice(v: Args): ProviderChoice {
  return {
    provider: v.provider ?? "openai",
    model: v.model ?? (v.provider === "mock" ? "mock" : need(v.model, "model")),
    baseUrl: v["base-url"],
    maxCostUsd: v["max-cost"] ? Number(v["max-cost"]) : undefined,
    confirmedPaidTier: v["confirm-paid-tier"],
  };
}

/** Prints the provider's data-handling disclosure once, before anything is sent. */
function announceProvider(v: Args, ctx: CliContext): void {
  const notice = providerNotice(v.provider ?? "openai");
  if (notice) info(ctx, notice);
}

interface OpenAdapter {
  adapter: EditorAdapter;
  dispose(): Promise<void>;
}

/** The database; its folder also holds the backups of files an edit replaced. */
const dbFile = (v: Args, ctx: CliContext) => v.db ?? path.join(dataDir(ctx.env), "jobs.db");
const backupRoot = (v: Args, ctx: CliContext) => path.join(path.dirname(path.resolve(dbFile(v, ctx))), "backups");

/** Lightroom needs the agent's loopback IPC server up and the plugin connected before any edit. */
async function openAdapter(v: Args, ctx: CliContext): Promise<OpenAdapter> {
  const name = v.adapter ?? "xmp";
  const backupDir = backupRoot(v, ctx);
  if (name === "xmp") return { adapter: new XmpSidecarAdapter({ backupDir }), dispose: async () => undefined };
  if (name === "render") return { adapter: new RenderAdapter({ backupDir }), dispose: async () => undefined };
  if (name === "rawtherapee") {
    return { adapter: new RawTherapeeAdapter({ binary: ctx.env.RAWTHERAPEE_CLI, run: ctx.run, backupDir }), dispose: async () => undefined };
  }
  if (name === "darktable") {
    return { adapter: new DarktableAdapter({ binary: ctx.env.DARKTABLE_CLI, run: ctx.run, backupDir, configDir: path.join(dataDir(ctx.env), "darktable") }), dispose: async () => undefined };
  }
  if (name === "lightroom") {
    const bridge = new LightroomBridge();
    await bridge.start();
    const handshake = path.join(dataDir(ctx.env), LIGHTROOM_HANDSHAKE_FILE);
    await writeBridgeHandshake(handshake, bridge.handshake());
    const adapter = new LightroomClassicAdapter(bridge);
    const dispose = async () => {
      await bridge.close();
      await removeBridgeHandshake(handshake, bridge.token);
    };
    const deadline = Date.now() + Number(v["plugin-wait"] ?? 60) * 1000;
    info(ctx, "Waiting for the VivahLens plugin in Lightroom Classic…");
    while (!(await adapter.detect())) {
      if (Date.now() > deadline) {
        await dispose();
        throw new VivahError("ADAPTER_EDITOR_NOT_RUNNING", "The Lightroom plugin did not connect. Open Lightroom Classic and enable the VivahLens plugin.");
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { adapter, dispose };
  }
  throw new Error(`Unknown adapter "${name}". Use xmp, rawtherapee, darktable, lightroom or render.`);
}

async function openStore(v: Args, ctx: CliContext): Promise<SqliteStore> {
  const file = dbFile(v, ctx);
  await fs.mkdir(path.dirname(file), { recursive: true });
  return new SqliteStore(file);
}

/** Writes every transfer to a model provider into the privacy ledger (metadata only: counts and sizes, never image content). */
const ledger = (store: SqliteStore, jobId?: string): Pick<GatewayOptions, "onTransfer"> => ({
  onTransfer: (event) => store.recordOutbound({ ...event, ...(jobId && { jobId }) }),
});

/** A gateway to the chosen provider plus the database it records transfers in. The caller closes the store. */
async function openGateway(v: Args, ctx: CliContext, jobId?: string): Promise<{ gateway: LlmGateway; store: SqliteStore }> {
  const store = await openStore(v, ctx);
  try {
    const prices = await loadPrices(v);
    return { gateway: buildGateway(providerChoice(v), ctx.env, { ...ledger(store, jobId), ...(prices && { prices: prices.table }) }), store };
  } catch (err) {
    store.close();
    throw err;
  }
}

const jobId = (v: Args, folder: string) => v.job ?? path.basename(path.resolve(folder));

async function loadProfile(file: string): Promise<StyleProfile> {
  return StyleProfileSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
}

async function learn(v: Args, ctx: CliContext): Promise<number> {
  const name = need(v.name, "name");
  const out = v.out ?? `${slug(name)}.profile.json`;

  if (v["from-xmp"]) {
    // Exact numbers from the photographer's own finished edits: no LLM, nothing leaves the machine.
    const { edits, skipped } = await readXmpEdits(v["from-xmp"]);
    if (edits.length === 0) throw new Error(`No usable Lightroom/Camera Raw XMP edits found in ${v["from-xmp"]}`);
    const generated = edits.filter((e) => e.generated).length;
    const profile = profileFromRecipes(edits.map((e) => e.recipe), { id: slug(name), name });
    await fs.writeFile(out, JSON.stringify(StyleProfileSchema.parse(profile), null, 2), "utf8");
    ctx.log(`Style "${name}" learned from ${edits.length} XMP edit(s)${skipped.length ? ` (${skipped.length} skipped)` : ""} and saved to ${out}\n  ${profile.summary}`);
    if (generated) info(ctx, `Note: ${generated} of these sidecars were written by VivahLens (possibly after your corrections), not purely your own edits.`);
    return 0;
  }

  const refsDir = need(v.refs, "refs");
  const refs = (await scanFolder(refsDir)).slice(0, MAX_REFERENCES);
  if (refs.length === 0) throw new Error(`No supported images found in ${refsDir}`);

  const { gateway, store } = await openGateway(v, ctx);
  try {
    announceProvider(v, ctx);
    info(ctx, `Sending ${refs.length} downscaled preview(s) to "${v.provider}" to learn the style…`);
    const previews = await Promise.all(refs.map((a) => loadPreview(a)));
    const profile = await learnStyle(gateway, { id: slug(name), name, references: previews });

    await fs.writeFile(out, JSON.stringify(StyleProfileSchema.parse(profile), null, 2), "utf8");
    ctx.log(`Style "${name}" saved to ${out}\n  ${profile.summary}`);
    return 0;
  } finally {
    store.close();
  }
}

interface PriceSource {
  table: VersionedPriceTable;
  /** Where it came from: the person's own file, or the signed remote catalog. */
  source: "file" | "remote";
}

/** The model price table: the file named by --prices when there is one, else what the signed remote config carries. */
async function loadPrices(v: Args, remote?: VersionedPriceTable): Promise<PriceSource | undefined> {
  if (v.prices) return { table: JSON.parse(await fs.readFile(v.prices, "utf8")) as VersionedPriceTable, source: "file" };
  return remote ? { table: remote, source: "remote" } : undefined;
}

/**
 * Cost line shown before any photo is sent; refuses to start when the estimate already exceeds the cap. A cap that cannot
 * be checked (no price for the model) is refused too, rather than silently not protecting anyone.
 */
async function announceCost(v: Args, ctx: CliContext, photos: number, prices?: PriceSource): Promise<void> {
  if (v.provider === "mock" || v.provider === "ollama") return info(ctx, "Estimated LLM cost: $0 (no paid API).");
  const capped = v["max-cost"] !== undefined;
  const unpriced = (why: string) => {
    if (capped) throw new VivahError("BUDGET_EXCEEDED", `--max-cost ${v["max-cost"]} cannot be checked: ${why}. Nothing was sent.`);
    info(ctx, `Estimated LLM cost: unknown (${why}; cap with --max-cost once it is).`);
  };
  if (!prices) return unpriced("pass --prices <file> with a price table");
  const { table, source } = prices;
  const estimate = estimateBatchCost(table, need(v.model, "model"), photos, { inputTokens: EST_INPUT_TOKENS, outputTokens: EST_OUTPUT_TOKENS });
  if (estimate === undefined) return unpriced(`model "${v.model}" is not in the price table`);
  info(ctx, `Estimated LLM cost: ≈ $${estimate.toFixed(2)} for ${photos} photo(s) (prices effective ${table.effectiveFrom}${source === "remote" ? ", from the signed remote catalog" : ""}; reasoning tokens not included).`);
  if (capped && estimate > Number(v["max-cost"])) {
    throw new VivahError("BUDGET_EXCEEDED", `Estimate $${estimate.toFixed(2)} exceeds --max-cost ${v["max-cost"]}; nothing was sent.`);
  }
}

async function edit(v: Args, ctx: CliContext, onProgress?: (event: { stage: string; done: number; total: number }) => void): Promise<number> {
  const folder = need(v.folder, "folder");
  const profile = await loadProfile(need(v.profile, "profile"));
  const assets = await scanFolder(folder);
  if (assets.length === 0) throw new Error(`No supported images found in ${folder}`);
  const license = await requireLicense(ctx.env, v.license, { adapterId: adapterName(v), operation: "edit" });
  info(ctx, license.line);
  assertWithinLimits(license.entitlement, { photos: assets.length });
  const remote = await remoteSettings(v, ctx, adapterName(v), "edit");
  const id = jobId(v, folder);
  const store = await openStore(v, ctx);
  const log = await openCommandLog(ctx.env, "edit", (line) => info(ctx, line));
  let opened: OpenAdapter | undefined;
  let pool: DecodePool | undefined;
  try {
    const prices = await loadPrices(v, remote?.prices);
    // Offline needs no model and no key: files already edited are reused, the rest wait for a run with a connection.
    const gateway = v.offline
      ? new LlmGateway()
      : buildGateway(providerChoice(v), ctx.env, { ...ledger(store, id), onCall: (call) => log.logger.info("llm.call", { jobId: id, ...call }), ...(prices && { prices: prices.table }) });
    if (v.offline) info(ctx, "Offline: nothing is sent anywhere. Photos that need the model wait; run again without --offline to finish them.");
    else {
      announceProvider(v, ctx);
      await announceCost(v, ctx, assets.length, prices);
    }

    opened = await openAdapter(v, ctx);
    const { adapter } = opened;
    // Decoding is most of a batch's time and runs in plain JavaScript, so spread it over cores when the compiled workers are there.
    const workers = v.workers !== undefined ? Number(v.workers) : defaultDecodeWorkers();
    if (!Number.isInteger(workers) || workers < 0) throw new Error(`--workers must be a whole number of 0 or more (0 decodes in the main thread), got "${v.workers}"`);
    pool = workers > 0 && DecodePool.available() ? new DecodePool({ size: workers }) : undefined;
    log.logger.info("decoder", { mode: pool ? "workers" : "in-thread", workers: pool ? workers : 0 });
    const analysis = new AnalysisCache(pool && ((a) => pool!.analysis(a)));
    if (!(await adapter.detect())) throw new VivahError("ADAPTER_EDITOR_NOT_RUNNING", `${adapter.id} was not found on this machine`);
    info(ctx, v.offline ? `Editing ${assets.length} photo(s) with "${adapter.id}" without the model.` : `Editing ${assets.length} photo(s) with "${adapter.id}". Previews (≤2048px, EXIF/GPS stripped) go to "${v.provider}"; originals stay put.`);
    const printProgress = progressPrinter((line) => info(ctx, line));
    const summary = await runJob(
      {
        store,
        library: store,
        gateway,
        adapter,
        profile,
        previewOf: (a) => (pool ? pool.preview(a) : loadPreview(a)),
        grayOf: (a) => analysis.gray(a),
        sceneOf: (a) => analysis.scene(a),
        describe: (a) => analysis.describe(a),
        offline: v.offline,
        // Enough photos in flight to keep every decoder busy; one thread cannot use more than a few at once.
        concurrency: v.concurrency ? Number(v.concurrency) : Math.max(4, pool ? workers : 0),
        signal: ctx.signal,
        onProgress: (event) => {
          printProgress(event);
          onProgress?.(event);
        },
        logger: log.logger,
      },
      { id, name: path.basename(folder), assets, retryFailed: v["retry-failed"] },
    );
    printSummary(summary, ctx);
    await announceFinished(
      v,
      ctx,
      summary.stoppedEarly ? "VivahLens: edit stopped" : "VivahLens: edit finished",
      `${path.basename(folder)}: ${summary.awaitingReview.length} ready for review, ${summary.rejected.length} culled, ${summary.failed.length} failed`,
    );
    if (adapter.id === "darktable" && summary.awaitingReview.length > 0) {
      ctx.log("Open darktable and import this folder to see the edits. For photos already in its library, turn on \"look for updated XMP files on startup\" in its storage settings.");
    }
    if (store.listUndo(id, { pending: true }).length) ctx.log(`To take these edits back out of your files: vivah undo --job ${id}`);
    const usage = gateway.usage();
    ctx.log(`LLM calls: ${usage.calls}, tokens in/out: ${usage.inputTokens}/${usage.outputTokens}`);
    const reported = await reportUsage({
      settings: SettingsStore.fromEnv(ctx.env),
      licenses: LicenseStore.fromEnv(ctx.env),
      usage: { photos: assets.length, llmCalls: usage.calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd },
    });
    log.logger.info("usage-report", { outcome: reported });
    return summary.failed.length > 0 ? 2 : 0;
  } finally {
    store.close();
    await opened?.dispose();
    await pool?.close();
    await log.close();
  }
}

const adapterName = (v: Args) => ({ xmp: "xmp-sidecar", lightroom: "lightroom-classic", render: "builtin-render" })[v.adapter ?? "xmp"] ?? v.adapter ?? "xmp";

/** Where signed documents come from: --server, else VIVAH_UPDATE_URL, else the license server this computer was activated with. */
const documentBase = (v: Args, ctx: CliContext) =>
  documentServer(ctx.env, v.server, async () => (await LicenseStore.fromEnv(ctx.env).readFields().catch(() => undefined))?.server);

/**
 * The signed remote settings, applied to this command: an adapter that has been switched off (an editor update broke it)
 * stops an edit with the reason, and one in beta is said to be. Exporting and reviewing are never blocked by it: work that
 * is already done can always be taken out. Without update keys, or without a server to ask, nothing changes.
 */
async function remoteSettings(v: Args, ctx: CliContext, adapterId: string, operation: "edit" | "export"): Promise<RemoteConfig | undefined> {
  const remote = await loadRemoteConfig({ env: ctx.env, dir: dataDir(ctx.env), offline: v.offline, baseUrl: await documentBase(v, ctx) });
  if (remote.note) info(ctx, remote.note);
  const { blocked, note } = adapterNotice(remote.config, adapterId);
  if (blocked && operation === "edit") throw new VivahError("ADAPTER_VERSION_UNSUPPORTED", blocked);
  if (blocked) info(ctx, `Note: ${blocked}`);
  else if (note) info(ctx, `Note: ${note}`);
  return remote.config;
}

/**
 * Opens what the review page needs for one job: the editor, the database, the license check and the delivery plan. The page's
 * server frees it through `dispose` when it moves on to another shoot or stops, and `dispose` is safe to call twice.
 */
async function openReviewSession(v: Args, ctx: CliContext): Promise<ReviewDeps> {
  const folder = need(v.folder, "folder");
  const profileFile = need(v.profile, "profile");
  const profile = await loadProfile(profileFile);
  const delivery = await deliveryFrom(v, ctx, folder);
  const license = await requireLicense(ctx.env, v.license, { adapterId: adapterName(v), operation: "export" });
  info(ctx, license.line);
  await remoteSettings(v, ctx, adapterName(v), "export");
  const { adapter, dispose } = await openAdapter(v, ctx);
  let store: SqliteStore | undefined;
  let log: Awaited<ReturnType<typeof openCommandLog>> | undefined;
  let closed = false;
  const release = async () => {
    if (closed) return;
    closed = true;
    store?.close();
    await dispose();
    await log?.close();
  };
  try {
    warnIfNothingExported(delivery, adapter, ctx);
    const opened = (store = await openStore(v, ctx));
    log = await openCommandLog(ctx.env, "review", (line) => info(ctx, line));
    return {
      store: opened,
      library: opened,
      logger: log.logger,
      jobId: jobId(v, folder),
      assets: await scanFolder(folder),
      adapter,
      profile,
      ...(license.pausedBecause && { editingPaused: license.pausedBecause }),
      previewOf: (a) => loadPreview(a, { maxEdge: 1024 }),
      renderPreview: createPreviewRenderer({ maxEdge: 1024 }),
      exportSpec: delivery?.spec,
      afterExport: delivery?.afterExport,
      onProfileUpdated: async (p) => {
        opened.saveProfile(p);
        await fs.writeFile(profileFile, JSON.stringify(p, null, 2), "utf8");
        ctx.log(`Style "${p.name}" updated from your adjustments (v${p.version}).`);
      },
      dispose: release,
    };
  } catch (err) {
    await release();
    throw err;
  }
}

/** The providers the page offers; one given on the command line is offered too, even if it needs more than a name and a key. */
const PAGE_PROVIDERS = ["mock", "openai", "anthropic", "gemini", "ollama"];
/** The editor routes that export finished JPEGs, which is what the output folder is for. */
const EXPORTING_ADAPTERS = new Set(["render", "rawtherapee", "darktable"]);

/**
 * What the review page does when it is opened without a job: learn the style from the folder of finished photos, edit the
 * folder of photos, and open the result for review. It is `learn`, `edit` and `review` run one after another with the choices
 * the person made on the page, so a license, a model price cap or a missing key stops it exactly as it would on the command line.
 * Without --adapter and --provider on the command line it uses the built-in renderer (which exports to the output folder) and
 * the offline demo model (which sends nothing anywhere): a cloud model is only used when the person picks one.
 */
function studioWorkflow(v: Args, ctx: CliContext, given: ReadonlySet<string>): StudioWorkflow {
  const adapter = given.has("adapter") ? (v.adapter ?? "render") : "render";
  const provider = given.has("provider") ? (v.provider ?? "mock") : "mock";
  const outputUsed = EXPORTING_ADAPTERS.has(adapter);
  const providers = [...new Set([...PAGE_PROVIDERS, provider])].map((id) => ({ id, needsModel: id !== "mock", local: id === "mock" || id === "ollama" }));
  const countPhotos = async (folder: string): Promise<number> => (await scanFolder(folder).catch(() => [])).length;

  const checkFolder = async (field: "input" | "profile", folder: string): Promise<void> => {
    if (!path.isAbsolute(folder)) throw new FieldError(field, "Enter the full path of a folder.");
    const found = await fs.stat(folder).catch(() => undefined);
    if (!found) throw new FieldError(field, "This folder was not found.");
    if (!found.isDirectory()) throw new FieldError(field, "This is not a folder.");
    if ((await countPhotos(folder)) === 0) throw new FieldError(field, "No photos in this folder. They must be directly inside it, not in a sub-folder.");
  };

  return {
    setup: {
      defaults: {
        ...(v.folder && { input: v.folder }),
        ...(v["export-dir"] && { output: v["export-dir"] }),
        ...(v.refs && { profile: v.refs }),
        provider,
        ...(given.has("provider") && v.model && { model: v.model }),
      },
      providers,
      outputUsed,
      maxReferences: MAX_REFERENCES,
    },
    countPhotos,
    async validate(request: StartRequest) {
      await checkFolder("input", request.input);
      await checkFolder("profile", request.profile);
      if (outputUsed) {
        const output = request.output?.trim();
        if (!output) throw new FieldError("output", "Choose where to save the edited photos.");
        if (!path.isAbsolute(output)) throw new FieldError("output", "Enter the full path of a folder.");
        const found = await fs.stat(output).catch(() => undefined);
        if (found && !found.isDirectory()) throw new FieldError("output", "This is not a folder.");
        if (await sameDirectory(request.input, output)) throw new FieldError("output", "Choose a different folder from the photos: exports never replace your original files.");
      }
      const chosen = request.provider ?? provider;
      const known = providers.find((p) => p.id === chosen);
      if (!known) throw new FieldError("provider", `Unknown model provider "${chosen}".`);
      if (known.needsModel && !request.model?.trim()) throw new FieldError("model", "Enter the model name.");
    },
    async start(request, hooks) {
      const name = path.basename(request.profile) || "style";
      const profileFile = path.join(dataDir(ctx.env), "styles", `${slug(name)}.profile.json`);
      await fs.mkdir(path.dirname(profileFile), { recursive: true });
      const chosen = request.provider ?? provider;
      const run: Args = {
        ...v,
        adapter,
        provider: chosen,
        model: chosen === "mock" ? undefined : request.model?.trim(),
        folder: request.input,
        refs: request.profile,
        name,
        out: profileFile,
        profile: profileFile,
        "export-dir": outputUsed ? request.output?.trim() : undefined,
        job: undefined,
        // Starting again means "do it": photos that failed last time are tried again.
        "retry-failed": true,
      };
      const say = (line: string) => {
        hooks.log(line);
        info(ctx, line);
      };
      const signal = AbortSignal.any(ctx.signal ? [hooks.signal, ctx.signal] : [hooks.signal]);
      const step: CliContext = { ...ctx, log: say, info: say, signal };

      hooks.progress({ stage: "learning", done: 0, total: 1 });
      if ((await learn(run, step)) !== 0) throw new Error("The style could not be learned.");
      signal.throwIfAborted();
      hooks.progress({ stage: "learning", done: 1, total: 1 });
      await edit(run, step, (event) => hooks.progress(event));
      signal.throwIfAborted();
      return openReviewSession(run, step);
    },
  };
}

async function review(v: Args, ctx: CliContext, given: ReadonlySet<string>): Promise<number> {
  const workflow = studioWorkflow(v, ctx, given);
  // With a folder and a profile on the command line the page opens on the photos; otherwise it starts by asking for them.
  const session = v.folder !== undefined && v.profile !== undefined ? await openReviewSession(v, ctx) : undefined;
  let server: ReviewServer;
  try {
    server = session ? await startReviewServer(session, { workflow }) : await startStudioServer(workflow);
  } catch (err) {
    await session?.dispose?.();
    throw err;
  }
  try {
    ctx.log(`Review UI (local only): ${server.url}\nPress Ctrl-C to stop.`);
    if (!v["no-open"] && ctx.openUrl) {
      const problem = await Promise.resolve(ctx.openUrl(server.url)).then(
        () => undefined,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      if (problem) info(ctx, `Could not open your browser (${problem}). Open the address above yourself.`);
    }
    await new Promise<void>((resolve) => {
      if (ctx.signal?.aborted) return resolve();
      ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return 0;
  } finally {
    // Stops an edit that is still running and frees the job that is open.
    await server.close();
  }
}

/** Delivery options apply to exported files, so they need an export folder; without one they would silently do nothing. */
async function deliveryFrom(v: Args, ctx: CliContext, folder: string): Promise<Delivery | undefined> {
  const dir = v["export-dir"];
  if (!dir) {
    const stray = DELIVERY_FLAGS.filter((flag) => v[flag] !== undefined && v[flag] !== false);
    if (stray.length) {
      throw new Error(`--${stray.join(", --")} need --export-dir. To finish files you already exported from your editor, use "vivah deliver".`);
    }
    return undefined;
  }
  // An export into the folder the photos came from would overwrite same-named JPEG originals (a RAW's camera JPEG), and a failed finish would delete them.
  if (await sameDirectory(folder, dir)) throw new Error("--export-dir must be a different folder from --folder: exports never replace your original files");
  const delivery = await planDelivery(v, dir);
  for (const line of delivery.notices) info(ctx, line);
  return delivery;
}

/** Edit-only adapters (XMP, Lightroom) never export, so export-time delivery options would be ignored. */
function warnIfNothingExported(delivery: Delivery | undefined, adapter: EditorAdapter, ctx: CliContext): void {
  if (delivery && !adapter.export) {
    info(ctx, `Note: "${adapter.id}" writes edits only and does not export, so the delivery options above will not apply. Export from your editor, then run "vivah deliver" on the JPEGs.`);
  }
}

async function exportCmd(v: Args, ctx: CliContext): Promise<number> {
  const folder = need(v.folder, "folder");
  if (!v["approve-all"] && !v.approve) throw new Error("Nothing approved: pass --approve <ids> or --approve-all after reviewing");
  const delivery = await deliveryFrom(v, ctx, folder);
  info(ctx, (await requireLicense(ctx.env, v.license, { adapterId: adapterName(v), operation: "export" })).line);
  await remoteSettings(v, ctx, adapterName(v), "export");
  const { adapter, dispose } = await openAdapter(v, ctx);
  warnIfNothingExported(delivery, adapter, ctx);
  const store = await openStore(v, ctx);
  const log = await openCommandLog(ctx.env, "export", (line) => info(ctx, line));
  try {
    const id = jobId(v, folder);
    const approve = v["approve-all"]
      ? store.listItems(id).filter((i) => i.state === "review").map((i) => i.assetId)
      : v.approve!.split(",").map((s) => s.trim());
    const result = await exportApproved(
      { store, library: store, adapter, afterExport: delivery?.afterExport, signal: ctx.signal, logger: log.logger },
      id,
      await scanFolder(folder),
      { approve, exportSpec: delivery?.spec },
    );
    if (result.exported.length) ctx.log(`Exported ${result.exported.length} photo(s) to ${v["export-dir"]}`);
    if (delivery?.tally.files) ctx.log(describeTally(delivery.tally));
    if (result.approved.length) ctx.log(`Approved ${result.approved.length} photo(s). "${adapter.id}" writes edits only; export from your editor.`);
    for (const f of result.failed) ctx.log(`  failed ${f.assetId}: [${f.code}] ${f.message}`);
    return result.failed.length > 0 ? 2 : 0;
  } finally {
    store.close();
    await dispose();
    await log.close();
  }
}

/** Finishes JPEGs that were exported elsewhere (e.g. from Lightroom) into a new folder; the originals are never modified. */
async function deliverCmd(v: Args, ctx: CliContext): Promise<number> {
  const folder = need(v.folder, "folder");
  const out = need(v.out, "out");
  if (v.format) throw new Error("--format applies to exports; deliver works on JPEG files");
  if (v["zip-max-mb"] && !v.zip) throw new Error("--zip-max-mb needs --zip");
  const zipMaxMb = v["zip-max-mb"] === undefined ? undefined : Number(v["zip-max-mb"]);
  if (zipMaxMb !== undefined && !(Number.isFinite(zipMaxMb) && zipMaxMb >= 1)) throw new Error(`--zip-max-mb must be a number of megabytes (at least 1), got "${v["zip-max-mb"]}"`);
  const concurrency = v.concurrency ? Number(v.concurrency) : 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`--concurrency must be a whole number of at least 1, got "${v.concurrency}"`);
  const delivery = await planDelivery(v, out);

  const names = (await fs.readdir(folder, { withFileTypes: true }))
    .filter((e) => e.isFile() && /\.jpe?g$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  if (names.length === 0) throw new Error(`No JPEG files found in ${folder}`);

  if (await sameDirectory(folder, out)) throw new Error("--out must be a different folder from --folder: delivered files never replace your exports");
  await fs.mkdir(out, { recursive: true });
  for (const line of delivery.notices) info(ctx, line);

  const finish = { ...delivery.finish, maxEdgePx: delivery.spec.maxEdgePx, quality: delivery.spec.quality };
  const progress = progressPrinter((line) => info(ctx, line));
  const delivered: string[] = [];
  const failed: { file: string; message: string }[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < names.length && !ctx.signal?.aborted) {
      const name = names[next++]!;
      try {
        const destination = path.join(out, name);
        await finishTracked(path.join(folder, name), destination, finish, delivery.tally);
        delivered.push(destination);
      } catch (err) {
        failed.push({ file: name, message: err instanceof Error ? err.message : String(err) });
      }
      progress({ stage: "finishing", done: ++done, total: names.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  ctx.signal?.throwIfAborted();

  let archives: string[] = [];
  if (v.zip && delivered.length) {
    // Next to the delivery folder, so the archive never ends up inside what it contains.
    const target = path.resolve(out);
    const zipped = await writeZip({
      files: delivered,
      outBase: path.join(path.dirname(target), path.basename(target) || "delivery"),
      maxPartBytes: zipMaxMb === undefined ? undefined : zipMaxMb * 1024 * 1024,
    });
    archives = zipped.archives;
  }

  if (v.json) {
    ctx.log(JSON.stringify({ out, delivered: delivered.length, failed, locationRemoved: delivery.tally.locationRemoved, reencoded: delivery.tally.reencoded, dropped: { files: delivery.tally.droppedFiles, kinds: [...delivery.tally.droppedKinds].sort() }, archives }, null, 2));
  } else {
    ctx.log(`Delivered ${delivered.length} of ${names.length} file(s) to ${out}`);
    ctx.log(`  ${describeTally(delivery.tally)}`);
    for (const f of failed) ctx.log(`  failed ${f.file}: ${f.message}`);
    for (const a of archives) ctx.log(`  ZIP: ${a}`);
  }
  await announceFinished(v, ctx, "VivahLens: delivery finished", `${delivered.length} of ${names.length} file(s) delivered to ${path.basename(path.resolve(out))}${failed.length ? `, ${failed.length} failed` : ""}`);
  return failed.length > 0 ? 2 : 0;
}

async function stats(v: Args, ctx: CliContext): Promise<number> {
  if (!v.folder && !v.job) throw new Error("--folder or --job is required");
  const store = await openStore(v, ctx);
  try {
    const id = v.job ?? jobId(v, v.folder!);
    if (!store.getJob(id)) throw new Error(`No job "${id}" in this database`);
    const s = jobStats(store, id, store);
    if (v.json) {
      ctx.log(JSON.stringify(s, null, 2));
      return 0;
    }
    const pct = (n: number | undefined) => (n === undefined ? "n/a (nothing approved yet)" : `${Math.round(n * 100)}%`);
    ctx.log(
      [
        `Job "${s.jobId}": ${s.total} photos`,
        `  culled: ${s.rejected.blurry} blurry, ${s.rejected.duplicate} near-duplicate, ${s.rejected.duplicateFile} duplicate file · failed: ${s.failed} · awaiting review: ${s.awaitingReview}`,
        `  approved: ${s.approved} (${s.approvedUnchanged} unchanged, ${s.overridden} corrected)`,
        `  acceptance rate: ${pct(s.acceptanceRate)} (Phase 0 target ≥ 70%)`,
        `  flagged as differing from the album: ${s.outliers}`,
        ...(Object.keys(s.correctionsByField).length
          ? [`  most corrected: ${Object.entries(s.correctionsByField).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(", ")}`]
          : []),
      ].join("\n"),
    );
    return 0;
  } finally {
    store.close();
  }
}

/** Phase 0 spike: how often does the LLM land within tolerance of what the photographer actually did? */
async function evalCmd(v: Args, ctx: CliContext): Promise<number> {
  const folder = need(v.folder, "folder");
  const profile = await loadProfile(need(v.profile, "profile"));
  const all = await scanFolder(folder);
  const withTruth: TruthCase[] = [];
  let ownOutput = 0;
  for (const asset of all) {
    const xmp = path.join(path.dirname(asset.path), `${path.parse(asset.path).name}.xmp`);
    if (!existsSync(xmp)) continue;
    const text = await fs.readFile(xmp, "utf8");
    // Sidecars written by `vivah edit` are the model's output, not ground truth.
    if (isGeneratedByVivah(text)) {
      ownOutput++;
      continue;
    }
    const expected = parseCrsToRecipe(text);
    if (expected && Object.keys(expected.adjustments).length) withTruth.push({ id: asset.id, asset, expected });
  }
  if (ownOutput) info(ctx, `Skipped ${ownOutput} photo(s) whose .xmp was written by VivahLens, not by you.`);
  const cases = withTruth.slice(0, v.limit ? Number(v.limit) : undefined);
  if (cases.length === 0) throw new Error(`No photos with a sibling .xmp edit made by you found in ${folder}`);

  const { gateway, store } = await openGateway(v, ctx);
  try {
    announceProvider(v, ctx);
    await announceCost(v, ctx, cases.length, await loadPrices(v));
    return await scoreCases(v, ctx, gateway, profile, cases);
  } finally {
    store.close();
  }
}

/** A photo with an edit the photographer made themselves, to score the model against. */
interface TruthCase {
  id: string;
  asset: AssetRef;
  expected: NonNullable<ReturnType<typeof parseCrsToRecipe>>;
}

/** Asks the model for a recipe for each photo and scores it against the photographer's own edit. */
async function scoreCases(v: Args, ctx: CliContext, gateway: LlmGateway, profile: StyleProfile, cases: readonly TruthCase[]): Promise<number> {
  info(ctx, `Scoring ${cases.length} photo(s) against your own edits. Previews go to "${v.provider}".`);

  const results: EvalCase[] = new Array(cases.length);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      ctx.signal?.throwIfAborted();
      const i = next++;
      const c = cases[i]!;
      try {
        results[i] = { id: c.id, expected: c.expected, actual: await proposeRecipe(gateway, { preview: await loadPreview(c.asset), profile }) };
      } catch {
        results[i] = { id: c.id, expected: c.expected, actual: undefined };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(v.concurrency ? Number(v.concurrency) : 3, cases.length) }, worker));

  const report = evaluateRecipes(results);
  const perceptual = v.perceptual
    ? await scorePerceptually(results.map((r, i) => ({ id: r.id, asset: cases[i]!.asset, expected: cases[i]!.expected, actual: r.actual })), { signal: ctx.signal })
    : undefined;
  const look = perceptual && { ...summarizePerceptual(perceptual.scores), skipped: perceptual.skipped };
  if (v.json) {
    ctx.log(JSON.stringify({ ...report, ...(look && { perceptual: { ...look, cases: perceptual!.scores } }) }, null, 2));
    return 0;
  }
  const usage = gateway.usage();
  const percent = (rate: number) => `${Math.round(rate * 100)}%`;
  ctx.log(
    [
      `Acceptance: ${Math.round(report.acceptanceRate * 100)}% (${report.accepted}/${report.total}) · schema-valid: ${Math.round(report.schemaValidRate * 100)}% · target ≥ 70%`,
      ...Object.entries(report.perField).map(([k, f]) => `  ${k.padEnd(20)} within tolerance ${f.withinTolerance}/${f.compared}, mean |Δ| ${f.meanAbsDelta.toFixed(2)}`),
      ...(look
        ? [
            `Look, from drawing both edits on the photo (CIEDE2000; framing left out): within ΔE ${LOOKS_THE_SAME}, the same at a glance: ${percent(look.looksTheSameRate)} · within ΔE ${LOOKS_CLOSE}, close: ${percent(look.looksCloseRate)} · mean ΔE ${look.meanDeltaE.toFixed(1)}, median ${look.medianDeltaE.toFixed(1)} · SSIM ${look.meanSsim.toFixed(2)} (${look.scored} scored${look.skipped ? `, ${look.skipped} left out` : ""})`,
          ]
        : []),
      `LLM calls: ${usage.calls}, tokens in/out: ${usage.inputTokens}/${usage.outputTokens}`,
    ].join("\n"),
  );
  return 0;
}

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".mxf", ".mts", ".m2ts", ".avi", ".mkv"];
/** The plan flag that unlocks rough cuts (Pro and Studio, plan §5). */
const VIDEO_FEATURE = "video-timeline";
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Binds this computer to a license key on the licensing server (plan §7d). */
async function activateCmd(v: Args, ctx: CliContext): Promise<number> {
  const server = v.server ?? ctx.env.VIVAH_SERVER;
  if (!server) throw new Error("--server is required (or set VIVAH_SERVER)");
  const store = LicenseStore.fromEnv(ctx.env);
  const license = await activateLicense({ store, server, licenseKey: need(v.key, "key"), deviceName: v["device-name"] ?? os.hostname() });

  const keySetting = ctx.env.VIVAH_LICENSE_PUBLIC_KEY;
  if (keySetting) {
    const { entitlement } = verifyEntitlement(license.entitlementToken, await readPublicKey(keySetting));
    ctx.log(`Activated this computer: ${describeEntitlement(entitlement)}.`);
  } else {
    ctx.log("Activated this computer. (Development build: the license signature was not checked because no public key is configured.)");
  }
  ctx.log(
    license.refreshTokenIn === "store"
      ? "The sign-in that renews this license is kept in your system's protected storage."
      : "The sign-in that renews this license is kept in a file only your account can read (this computer has no protected storage to use).",
  );
  return 0;
}

async function licenseCmd(ctx: CliContext): Promise<number> {
  const store = LicenseStore.fromEnv(ctx.env);
  const stored = await store.read();
  if (!stored) {
    ctx.log("This computer is not activated. Run `vivah activate --server <url> --key <license key>`.");
    return 1;
  }
  const keySetting = ctx.env.VIVAH_LICENSE_PUBLIC_KEY;
  if (!keySetting) {
    ctx.log(`Activated with ${stored.server}. Set VIVAH_LICENSE_PUBLIC_KEY to verify and show the plan.`);
    return 0;
  }
  const current = await currentEntitlement({ store, publicKey: await readPublicKey(keySetting) });
  const decision = accessFor(current);
  const note = current.refreshed ? " (renewed just now)" : current.offline ? " (offline: showing the saved license)" : "";
  ctx.log(`${describeEntitlement(current.entitlement)}; ${describeStatus(current.status, decision)}${note}`);
  return decision.access === "full" ? 0 : 1;
}

async function deactivateCmd(ctx: CliContext): Promise<number> {
  const { serverNotified } = await deactivateLicense({ store: LicenseStore.fromEnv(ctx.env) });
  ctx.log(serverNotified ? "Deactivated. This computer's license slot is free." : "Deactivated locally; the server could not be reached, so free the slot from your account later.");
  return 0;
}

/** Checks for a newer version. The manifest is signed and verified here; nothing is downloaded or installed. */
async function updateCmd(v: Args, ctx: CliContext): Promise<number> {
  const channel = (v.channel ?? "stable") as Channel;
  if (!["alpha", "beta", "stable"].includes(channel)) throw new Error("--channel must be stable, beta or alpha");
  const pinned = await pinnedKeys(ctx.env);
  if (Object.keys(pinned).length === 0) {
    ctx.log("Update checks are off in this build because it has no update keys. (Set VIVAH_UPDATE_KEYS to try one.)");
    return 0;
  }
  const baseUrl = await documentBase(v, ctx);
  if (!baseUrl) throw new Error("--server is required (or set VIVAH_UPDATE_URL, or activate this computer first)");
  const dir = dataDir(ctx.env);
  const check = await checkForUpdates({ baseUrl, channel, currentVersion: APP_VERSION, installId: await installId(dir), target: updateTarget(), pinned, state: new TrustState(dir) });
  if (v.json) ctx.log(JSON.stringify(check, null, 2));
  else for (const line of describeUpdate(check)) ctx.log(line);
  return 0;
}

/** Turns the opt-in usage report on or off, and says exactly what it sends. */
async function telemetryCmd(choice: string | undefined, ctx: CliContext): Promise<number> {
  const settings = SettingsStore.fromEnv(ctx.env);
  if (choice === "on" || choice === "off") await settings.update({ telemetry: { usage: choice === "on" } });
  else if (choice !== undefined && choice !== "status") {
    ctx.log("Usage: vivah telemetry [on|off|status]");
    return 1;
  }
  const on = await settings.usageReporting();
  ctx.log(`Usage reporting is ${on ? "on" : "off"}.`);
  ctx.log(`${on ? "After" : "If you turn it on with `vivah telemetry on`, after"} each \`vivah edit\` these counts are sent to your license server:`);
  for (const [field, meaning] of Object.entries(USAGE_FIELDS)) ctx.log(`  ${field}: ${meaning}`);
  ctx.log("Never sent: photos or previews, file or folder names, styles, keys, or anything you typed. A diagnostics file is only ever written on this computer; you choose whether to send it.");
  if (on && !(await LicenseStore.fromEnv(ctx.env).readFields().catch(() => undefined))) ctx.log("This computer is not activated yet, so nothing is sent. Run `vivah activate` first.");
  return 0;
}

/** Writes a file support can use to see what went wrong, with nothing personal in it. The user reads it and decides whether to send it. */
async function diagnosticsCmd(v: Args, ctx: CliContext): Promise<number> {
  let store: SqliteStore | undefined;
  try {
    let id: string | undefined;
    if (v.job !== undefined || v.folder !== undefined) {
      const file = dbFile(v, ctx);
      if (!existsSync(file)) throw new Error(`No job database at ${file}. Pass --db if yours is somewhere else.`);
      store = await openStore(v, ctx);
      id = v.job ?? jobId(v, v.folder!);
      if (!store.getJob(id)) throw new Error(`No job "${id}" in this database`);
    }
    const bundle = await buildDiagnostics({ env: ctx.env, run: ctx.run ?? runProcess, ...(store && { store }), ...(id && { jobId: id }), ...(v.folder && { folder: v.folder }) });
    const text = JSON.stringify(bundle, null, 2);
    const out = path.resolve(v.out ?? `vivah-diagnostics-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}.json`);
    await fs.writeFile(out, text, "utf8");
    ctx.log(`Wrote ${out} (${Math.max(1, Math.round(Buffer.byteLength(text) / 1024))} KB).`);
    for (const note of bundle.notes) ctx.log(note);
    return 0;
  } finally {
    store?.close();
  }
}

/** Looks at everything a first run needs and says what to do about what is missing. */
async function doctorCmd(v: Args, ctx: CliContext): Promise<number> {
  const checks = await runDoctor({ env: ctx.env, run: ctx.run ?? runProcess });
  ctx.log(v.json ? JSON.stringify({ checks }, null, 2) : formatDoctor(checks));
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}

/** Puts a plugin where its editor looks for plugins. Only Lightroom Classic has one so far. */
async function pluginCmd(which: string | undefined, ctx: CliContext): Promise<number> {
  if (which !== "lightroom") {
    ctx.log("Usage: vivah plugin lightroom   (installs the VivahLens plugin into Lightroom Classic)");
    return 1;
  }
  const modulesDir = lightroomModulesDir(process.platform, ctx.env, os.homedir());
  if (!modulesDir) throw new Error("Lightroom Classic runs on Windows and macOS only; there is no plugin folder on this system.");
  const result = await installLightroomPlugin({ modulesDir });
  ctx.log(`${result.replaced ? "Updated" : "Installed"} the VivahLens plugin${result.version ? ` ${result.version}` : ""} in ${result.folder}`);
  ctx.log("Restart Lightroom Classic (or File > Plug-in Manager > Reload Plug-in), then run: vivah edit --adapter lightroom ...");
  return 0;
}

/** Rough-cut highlight reel: analyse clips, pick the best moments (optionally on the beat and in story order), write a timeline. */
async function cutCmd(v: Args, ctx: CliContext): Promise<number> {
  const folder = need(v.folder, "folder");
  const targetSec = v.duration ? Number(v.duration) : 90;
  if (!Number.isFinite(targetSec) || targetSec <= 0) throw new Error("--duration must be a positive number of seconds");
  const formats = ({ fcpxml: ["fcpxml"], edl: ["edl"], both: ["fcpxml", "edl"] } as const)[v.timeline as "fcpxml" | "edl" | "both"];
  if (!formats) throw new Error("--timeline must be fcpxml, edl or both");
  info(ctx, (await requireLicense(ctx.env, v.license, { adapterId: VIDEO_FEATURE, operation: "edit" })).line);

  const ff = new Ffmpeg({ ffmpeg: ctx.env.FFMPEG, ffprobe: ctx.env.FFPROBE, run: ctx.run });
  const version = await ff.detect();
  if (!version) throw new VivahError("ADAPTER_EDITOR_NOT_RUNNING", "ffmpeg was not found. Install it from https://ffmpeg.org or set FFMPEG and FFPROBE to its path.");

  const files = (await fs.readdir(folder, { withFileTypes: true }))
    .filter((e) => e.isFile() && VIDEO_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(folder, e.name))
    .sort();
  if (files.length === 0) throw new Error(`No video files found in ${folder}`);

  info(ctx, `Probing ${files.length} clip(s) with ffmpeg ${version}…`);
  const probed: ProbedClip[] = [];
  for (const file of files) {
    try {
      probed.push(await ff.probe(file));
    } catch (err) {
      info(ctx, `  skipped ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (probed.length === 0) throw new Error("None of the clips could be read.");
  // Story order is capture order: container creation time when every clip has one, otherwise file name.
  const clips = probed.every((c) => c.createdAt) ? [...probed].sort((a, b) => a.createdAt!.localeCompare(b.createdAt!)) : probed;

  const features = [];
  for (const [i, clip] of clips.entries()) {
    ctx.signal?.throwIfAborted();
    info(ctx, `  Analysing ${clip.clipId} (${i + 1}/${clips.length})`);
    features.push(await analyzeClip(ff, clip, i));
  }

  let beats;
  if (v.music) {
    beats = await analyzeMusic(ff, v.music);
    info(ctx, beats ? `Music: ${beats.bpm.toFixed(1)} BPM (${Math.round(beats.confidence * 100)}% confidence).` : "Music: no steady beat found; cuts will not be beat-aligned.");
  }

  const opts = {
    targetSec,
    minSegSec: v["min-seg"] ? Number(v["min-seg"]) : undefined,
    maxSegSec: v["max-seg"] ? Number(v["max-seg"]) : undefined,
    beats,
  };
  let { picks, warnings } = choosePicks(features, opts);

  if (v.narrative) {
    const { gateway, store } = await openGateway(v, ctx);
    try {
      announceProvider(v, ctx);
      info(ctx, `Sending ${picks.length} thumbnail(s) (previews only) to "${v.provider}" to order the story…`);
      const byId = new Map(clips.map((c) => [c.clipId, c]));
      const shots = [];
      for (const pick of picks) {
        shots.push({ pick, thumbnail: await ff.thumbnail(byId.get(pick.clipId)!.path, (pick.availableIn + pick.availableOut) / 2) });
      }
      const story = await orderByNarrative(gateway, shots);
      picks = story.picks;
      warnings = [...warnings, ...story.warnings];
      if (story.usedLlm) info(ctx, `Story order: ${story.labels.filter(Boolean).join(" → ") || "reordered"}`);
    } finally {
      store.close();
    }
  }

  const plan = layoutPicks(picks, opts, warnings);
  const notesBefore: string[] = [];
  const name = v.name ?? "Highlights";
  const outDir = v["export-dir"] ?? folder;
  const recipe: EditRecipe = {
    version: "1.0",
    assetType: "video",
    adjustments: {
      videoEdits: {
        cuts: plan.cuts.map((c, i) => ({ clipId: c.clipId, inSec: round3(c.inSec), outSec: round3(c.outSec), ...(v.crossfade && i > 0 && { transitionIn: "crossfade" as const }) })),
      },
    },
  };

  // The music is laid under the picture as well as used for the beat grid; a missing or unreadable file is a note, not a failure.
  let music: MusicTrack | undefined;
  if (v.music) {
    try {
      music = {
        ...(await ff.probeAudio(v.music)),
        ...(v["music-start"] && { startSec: Number(v["music-start"]) }),
        ...(v["music-gain"] && { gainDb: Number(v["music-gain"]) }),
      };
    } catch (err) {
      notesBefore.push(`The music was not placed on the timeline: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const written: string[] = [];
  const notes = [...plan.warnings, ...notesBefore];
  for (const format of formats) {
    const adapter = new TimelineFileAdapter({ format, clips, fps: v.fps ? parseFps(v.fps) : undefined, ...(music && { music }), ...(v["drop-frame"] && { dropFrame: true }) });
    const res = await adapter.applyRecipe({ id: name, kind: "video", path: path.join(outDir, name) }, recipe);
    written.push(...res.outputs);
    notes.push(...(res.warnings ?? []));
  }

  ctx.log(
    `Rough cut: ${plan.cuts.length} cut(s) from ${Object.keys(plan.clipSeconds).length} of ${clips.length} clip(s), ${plan.totalSec.toFixed(1)}s (target ${targetSec}s)` +
      `${plan.alignedCuts ? `, ${plan.alignedCuts} on the beat` : ""}.`,
  );
  for (const file of written) ctx.log(`  wrote ${file}`);
  for (const note of [...new Set(notes)]) ctx.log(`  note: ${note}`);
  ctx.log("Import the timeline into your editor (FCPXML: Final Cut Pro or DaVinci Resolve; EDL: Premiere Pro or Resolve) and review before delivering.");
  return 0;
}

/** What has been sent to model providers: counts and sizes from the local ledger, never any image content (plan §3, §7k). */
async function privacyCmd(v: Args, ctx: CliContext): Promise<number> {
  const store = await openStore(v, ctx);
  try {
    const events = store.listOutbound(v.job ? { jobId: v.job } : undefined);
    const { totals, providers } = summarizeOutbound(events);
    if (v.json) {
      ctx.log(JSON.stringify({ job: v.job, totals, providers }, null, 2));
      return 0;
    }
    const scope = v.job ? `for job "${v.job}"` : "in total";
    if (events.length === 0) {
      ctx.log(`Nothing has been sent to any model provider ${scope}.`);
      return 0;
    }
    const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
    if (totals.calls === 0) {
      ctx.log(`Nothing has left this computer ${scope}: every request went to a model running here.`);
    } else {
      ctx.log(`Sent to model providers ${scope}: ${totals.images} image(s), ${mb(totals.imageBytes)}, in ${totals.calls} request(s).`);
      ctx.log(totals.fullResolutionCalls > 0 ? `  Full-resolution images were sent in ${totals.fullResolutionCalls} request(s).` : `  Previews only${totals.maxEdgePx ? ` (largest ${totals.maxEdgePx} px)` : ""}: your originals were never sent.`);
    }
    for (const p of providers) {
      const purposes = Object.entries(p.purposes).map(([k, n]) => `${k} ×${n}`).join(", ");
      ctx.log(`  ${p.provider}${p.local ? " (this computer, nothing left it)" : ""}: ${p.calls} request(s), ${p.images} image(s), ${mb(p.imageBytes)}, ${p.inputTokens}/${p.outputTokens} tokens in/out; ${purposes}${p.failedCalls ? `; ${p.failedCalls} failed` : ""}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

/** Takes a job's edits back out of the files they were written to (plan §7g). */
async function undoCmd(v: Args, ctx: CliContext): Promise<number> {
  if (!v.folder && !v.job) throw new Error("--folder or --job is required");
  const store = await openStore(v, ctx);
  const log = await openCommandLog(ctx.env, "undo", (line) => info(ctx, line));
  try {
    const id = v.job ?? jobId(v, v.folder!);
    if (!store.getJob(id)) throw new Error(`No job "${id}" in this database`);
    if (store.listUndo(id).length === 0) {
      ctx.log(`Nothing to undo for job "${id}": no changes to files were recorded. Edits made inside an editor (Lightroom) are undone there, from its History panel.`);
      return 0;
    }
    const photos = v.photos?.split(",").map((s) => s.trim()).filter(Boolean);
    const result = await undoJob({ store, library: store }, id, { force: v.force, dryRun: v["dry-run"], assetIds: photos });
    log.logger.info("undo", { jobId: id, dryRun: v["dry-run"] === true, restored: result.restored.length, removed: result.removed.length, skipped: result.skipped.map((s) => s.reason) });
    if (v.json) {
      ctx.log(JSON.stringify(result, null, 2));
    } else {
      const would = v["dry-run"] ? "would be " : "";
      if (result.restored.length) ctx.log(`${result.restored.length} file(s) ${would}put back as they were.`);
      if (result.removed.length) ctx.log(`${result.removed.length} file(s) ${would}deleted (VivahLens created them).`);
      for (const s of result.skipped) ctx.log(`  left alone ${s.target}: ${s.reason}`);
      if (!result.restored.length && !result.removed.length && !result.skipped.length) ctx.log("Everything was already undone.");
      else if (!v["dry-run"] && (result.restored.length || result.removed.length)) ctx.log(`Photos that were waiting for review go back to "edit proposed"; run "vivah edit" again to re-apply them.`);
    }
    return result.skipped.length > 0 ? 2 : 0;
  } finally {
    store.close();
    await log.close();
  }
}

function printSummary(s: ReviewSummary, ctx: CliContext): void {
  ctx.log(`Job "${s.jobId}": ${s.awaitingReview.length} ready for review, ${s.rejected.length} culled, ${s.failed.length} failed`);
  const reasons = Object.values(s.rejectReasons).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {});
  if (Object.keys(reasons).length) ctx.log(`  culled: ${Object.entries(reasons).map(([r, n]) => `${n} ${r}`).join(", ")}`);
  if (s.waitingForModel.length) ctx.log(`  waiting for the model: ${s.waitingForModel.length} photo(s); run "vivah edit" again without --offline to finish them`);
  if (s.stoppedEarly) ctx.log(`  stopped early: [${s.stoppedEarly.code}] ${s.stoppedEarly.message}\n  Photos not yet started were left as they were; fix this and run the same command again to continue.`);
  for (const f of s.failed) ctx.log(`  failed ${f.assetId}: [${f.code}] ${f.message}`);
  for (const [id, fields] of Object.entries(s.unsupported)) ctx.log(`  note ${id}: adapter ignores ${fields.join(", ")}`);
  for (const [id, notes] of Object.entries(s.warnings)) for (const note of notes) ctx.log(`  note ${id}: ${note}`);
  for (const [id, fields] of Object.entries(s.outliers)) ctx.log(`  check ${id}: differs from the album in ${fields.join(", ")}`);
  for (const [id, job] of Object.entries(s.seenBefore)) ctx.log(`  note ${id}: already processed in job "${job}"`);
  if (s.awaitingReview.length) ctx.log("Run `vivah review` to approve and adjust, or `vivah export` to approve from the command line.");
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "style";
