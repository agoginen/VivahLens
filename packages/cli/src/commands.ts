import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { RawTherapeeAdapter } from "@vivahlens/adapter-rawtherapee";
import { isGeneratedByVivah, parseCrsToRecipe, readXmpEdits, XmpSidecarAdapter } from "@vivahlens/adapter-xmp";
import { LightroomClassicAdapter, PluginIpcServer } from "@vivahlens/adapter-lightroom";
import {
  estimateBatchCost,
  evaluateRecipes,
  exportApproved,
  jobStats,
  learnStyle,
  profileFromRecipes,
  proposeRecipe,
  runJob,
  SqliteStore,
  StyleProfileSchema,
  VivahError,
  type EditorAdapter,
  type EvalCase,
  type ReviewSummary,
  type StyleProfile,
  type VersionedPriceTable,
} from "@vivahlens/core";
import { loadPreview, scanFolder } from "@vivahlens/ingest";
import { startReviewServer } from "@vivahlens/review";
import { AnalysisCache } from "./analysisCache.js";
import { requireLicense } from "./license.js";
import { progressPrinter } from "./progress.js";
import { buildGateway, providerNotice, type ProviderChoice } from "./providers.js";

export interface CliContext {
  env: Record<string, string | undefined>;
  /** Results (summaries, JSON): stdout. */
  log(line: string): void;
  /** Progress, notices and cost lines: stderr, so `--json` output stays machine-readable. Defaults to `log`. */
  info?(line: string): void;
  /** Long-running commands stop when this aborts; the binary wires it to Ctrl-C. */
  signal?: AbortSignal;
}

const info = (ctx: CliContext, line: string): void => (ctx.info ?? ctx.log)(line);

const USAGE = `vivah: AI editing automation (local-first)

  vivah learn  --refs <dir> --name <style> [--out profile.json]      learn a style from finished photos (LLM)
  vivah learn  --from-xmp <dir> --name <style>                       learn from your own Lightroom edits (exact, no LLM)
  vivah edit   --folder <dir> --profile <file> [--adapter xmp|rawtherapee|lightroom]
                                                                    cull, propose and apply edits, then stop for review
  vivah review --folder <dir> --profile <file> [--export-dir <dir>]  open the local review UI (approve, adjust, export)
  vivah export --folder <dir> (--approve a.cr3,b.cr3 | --approve-all) [--export-dir <dir>]
                                                                    approve/export from the command line
  vivah stats  (--folder <dir> | --job <id>) [--json]                acceptance rate and corrections for a job
  vivah eval   --folder <dir> --profile <file> [--limit <n>] [--json]
                                                                    score LLM edits against your own XMP edits (Phase 0 test)

Common: --provider mock|openai|anthropic|gemini|ollama|openai-compatible  --model <id>  [--base-url <url>]
        --prices <file>  --max-cost <usd>  --db <file>  --job <id>  --concurrency <n>  --retry-failed
        --license <file>  --confirm-paid-tier (gemini only)
Lightroom: --plugin-wait <seconds> (default 60) while the VivahLens plugin connects.
Keys are read from OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / VIVAH_API_KEY; RAWTHERAPEE_CLI overrides the rawtherapee-cli path.
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
  limit: { type: "string" },
  json: { type: "boolean" },
  license: { type: "string" },
  "max-cost": { type: "string" },
  prices: { type: "string" },
  "plugin-wait": { type: "string" },
  "retry-failed": { type: "boolean" },
  "confirm-paid-tier": { type: "boolean" },
  provider: { type: "string", default: "openai" },
  model: { type: "string" },
  "base-url": { type: "string" },
  approve: { type: "string" },
  "approve-all": { type: "boolean" },
  "export-dir": { type: "string" },
  format: { type: "string", default: "jpeg" },
  quality: { type: "string" },
  help: { type: "boolean" },
} as const;

type Args = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

/** Entry point shared by the binary and tests. Returns the process exit code. */
export async function runCli(argv: readonly string[], ctx: CliContext): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true });
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
        return await review(values, ctx);
      case "export":
        return await exportCmd(values, ctx);
      case "stats":
        return await stats(values, ctx);
      case "eval":
        return await evalCmd(values, ctx);
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

/** Lightroom needs the agent's loopback IPC server up and the plugin connected before any edit. */
async function openAdapter(v: Args, ctx: CliContext): Promise<OpenAdapter> {
  const name = v.adapter ?? "xmp";
  if (name === "xmp") return { adapter: new XmpSidecarAdapter(), dispose: async () => undefined };
  if (name === "rawtherapee") {
    return { adapter: new RawTherapeeAdapter({ binary: ctx.env.RAWTHERAPEE_CLI }), dispose: async () => undefined };
  }
  if (name === "lightroom") {
    const ipc = new PluginIpcServer();
    await ipc.start();
    const handshake = path.join(os.homedir(), ".vivahlens", "lightroom.json");
    await fs.mkdir(path.dirname(handshake), { recursive: true });
    await fs.writeFile(handshake, JSON.stringify(ipc.handshake()), { encoding: "utf8", mode: 0o600 });
    const adapter = new LightroomClassicAdapter(ipc);
    const dispose = async () => {
      await ipc.close();
      await fs.rm(handshake, { force: true });
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
  throw new Error(`Unknown adapter "${name}". Use xmp, rawtherapee or lightroom.`);
}

async function openStore(v: Args): Promise<SqliteStore> {
  const file = v.db ?? path.join(os.homedir(), ".vivahlens", "jobs.db");
  await fs.mkdir(path.dirname(file), { recursive: true });
  return new SqliteStore(file);
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

  const gateway = buildGateway(providerChoice(v), ctx.env);
  announceProvider(v, ctx);
  info(ctx, `Sending ${refs.length} downscaled preview(s) to "${v.provider}" to learn the style…`);
  const previews = await Promise.all(refs.map((a) => loadPreview(a)));
  const profile = await learnStyle(gateway, { id: slug(name), name, references: previews });

  await fs.writeFile(out, JSON.stringify(StyleProfileSchema.parse(profile), null, 2), "utf8");
  ctx.log(`Style "${name}" saved to ${out}\n  ${profile.summary}`);
  return 0;
}

/** Cost line shown before any photo is sent; refuses to start when the estimate already exceeds the cap. */
async function announceCost(v: Args, ctx: CliContext, photos: number): Promise<void> {
  if (v.provider === "mock" || v.provider === "ollama") return info(ctx, "Estimated LLM cost: $0 (no paid API).");
  if (!v.prices) return info(ctx, "Estimated LLM cost: unknown (pass --prices <file> with a price table; cap with --max-cost).");
  const table = JSON.parse(await fs.readFile(v.prices, "utf8")) as VersionedPriceTable;
  const estimate = estimateBatchCost(table, need(v.model, "model"), photos, { inputTokens: EST_INPUT_TOKENS, outputTokens: EST_OUTPUT_TOKENS });
  if (estimate === undefined) return info(ctx, `Estimated LLM cost: unknown (model "${v.model}" is not in the price table).`);
  info(ctx, `Estimated LLM cost: ≈ $${estimate.toFixed(2)} for ${photos} photo(s) (prices effective ${table.effectiveFrom}; reasoning tokens not included).`);
  if (v["max-cost"] && estimate > Number(v["max-cost"])) {
    throw new VivahError("BUDGET_EXCEEDED", `Estimate $${estimate.toFixed(2)} exceeds --max-cost ${v["max-cost"]}; nothing was sent.`);
  }
}

async function edit(v: Args, ctx: CliContext): Promise<number> {
  const folder = need(v.folder, "folder");
  const profile = await loadProfile(need(v.profile, "profile"));
  const assets = await scanFolder(folder);
  if (assets.length === 0) throw new Error(`No supported images found in ${folder}`);
  info(ctx, await requireLicense(ctx.env, v.license, adapterName(v)));
  const gateway = buildGateway(providerChoice(v), ctx.env);
  announceProvider(v, ctx);
  await announceCost(v, ctx, assets.length);

  const { adapter, dispose } = await openAdapter(v, ctx);
  const store = await openStore(v);
  const analysis = new AnalysisCache();
  try {
    if (!(await adapter.detect())) throw new VivahError("ADAPTER_EDITOR_NOT_RUNNING", `${adapter.id} was not found on this machine`);
    info(ctx, `Editing ${assets.length} photo(s) with "${adapter.id}". Previews (≤2048px, EXIF/GPS stripped) go to "${v.provider}"; originals stay put.`);
    const summary = await runJob(
      {
        store,
        library: store,
        gateway,
        adapter,
        profile,
        previewOf: (a) => loadPreview(a),
        grayOf: (a) => analysis.gray(a),
        sceneOf: (a) => analysis.scene(a),
        describe: (a) => analysis.describe(a),
        concurrency: v.concurrency ? Number(v.concurrency) : undefined,
        signal: ctx.signal,
        onProgress: progressPrinter((line) => info(ctx, line)),
      },
      { id: jobId(v, folder), name: path.basename(folder), assets, retryFailed: v["retry-failed"] },
    );
    printSummary(summary, ctx);
    const usage = gateway.usage();
    ctx.log(`LLM calls: ${usage.calls}, tokens in/out: ${usage.inputTokens}/${usage.outputTokens}`);
    return summary.failed.length > 0 ? 2 : 0;
  } finally {
    store.close();
    await dispose();
  }
}

const adapterName = (v: Args) => ({ xmp: "xmp-sidecar", lightroom: "lightroom-classic" })[v.adapter ?? "xmp"] ?? v.adapter ?? "xmp";

async function review(v: Args, ctx: CliContext): Promise<number> {
  const folder = need(v.folder, "folder");
  const profileFile = need(v.profile, "profile");
  const profile = await loadProfile(profileFile);
  info(ctx, await requireLicense(ctx.env, v.license, adapterName(v)));
  const { adapter, dispose } = await openAdapter(v, ctx);
  const store = await openStore(v);
  try {
    const server = await startReviewServer({
      store,
      library: store,
      jobId: jobId(v, folder),
      assets: await scanFolder(folder),
      adapter,
      profile,
      previewOf: (a) => loadPreview(a, { maxEdge: 1024 }),
      exportSpec: exportSpecFrom(v),
      onProfileUpdated: async (p) => {
        store.saveProfile(p);
        await fs.writeFile(profileFile, JSON.stringify(p, null, 2), "utf8");
        ctx.log(`Style "${p.name}" updated from your adjustments (v${p.version}).`);
      },
    });
    ctx.log(`Review UI (local only): ${server.url}\nPress Ctrl-C to stop.`);
    await new Promise<void>((resolve) => {
      if (ctx.signal?.aborted) return resolve();
      ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    await server.close();
    return 0;
  } finally {
    store.close();
    await dispose();
  }
}

function exportSpecFrom(v: Args) {
  return v["export-dir"]
    ? { format: v.format === "tiff" ? ("tiff" as const) : ("jpeg" as const), quality: v.quality ? Number(v.quality) : undefined, outputDir: v["export-dir"] }
    : undefined;
}

async function exportCmd(v: Args, ctx: CliContext): Promise<number> {
  const folder = need(v.folder, "folder");
  if (!v["approve-all"] && !v.approve) throw new Error("Nothing approved: pass --approve <ids> or --approve-all after reviewing");
  info(ctx, await requireLicense(ctx.env, v.license, adapterName(v)));
  const { adapter, dispose } = await openAdapter(v, ctx);
  const store = await openStore(v);
  try {
    const id = jobId(v, folder);
    const approve = v["approve-all"]
      ? store.listItems(id).filter((i) => i.state === "review").map((i) => i.assetId)
      : v.approve!.split(",").map((s) => s.trim());
    const result = await exportApproved({ store, library: store, adapter }, id, await scanFolder(folder), { approve, exportSpec: exportSpecFrom(v) });
    if (result.exported.length) ctx.log(`Exported ${result.exported.length} photo(s) to ${v["export-dir"]}`);
    if (result.approved.length) ctx.log(`Approved ${result.approved.length} photo(s). "${adapter.id}" writes edits only; export from your editor.`);
    for (const f of result.failed) ctx.log(`  failed ${f.assetId}: [${f.code}] ${f.message}`);
    return result.failed.length > 0 ? 2 : 0;
  } finally {
    store.close();
    await dispose();
  }
}

async function stats(v: Args, ctx: CliContext): Promise<number> {
  if (!v.folder && !v.job) throw new Error("--folder or --job is required");
  const store = await openStore(v);
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
  const withTruth: { id: string; asset: (typeof all)[number]; expected: NonNullable<ReturnType<typeof parseCrsToRecipe>> }[] = [];
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

  const gateway = buildGateway(providerChoice(v), ctx.env);
  announceProvider(v, ctx);
  await announceCost(v, ctx, cases.length);
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
  if (v.json) {
    ctx.log(JSON.stringify(report, null, 2));
    return 0;
  }
  const usage = gateway.usage();
  ctx.log(
    [
      `Acceptance: ${Math.round(report.acceptanceRate * 100)}% (${report.accepted}/${report.total}) · schema-valid: ${Math.round(report.schemaValidRate * 100)}% · target ≥ 70%`,
      ...Object.entries(report.perField).map(([k, f]) => `  ${k.padEnd(20)} within tolerance ${f.withinTolerance}/${f.compared}, mean |Δ| ${f.meanAbsDelta.toFixed(2)}`),
      `LLM calls: ${usage.calls}, tokens in/out: ${usage.inputTokens}/${usage.outputTokens}`,
    ].join("\n"),
  );
  return 0;
}

function printSummary(s: ReviewSummary, ctx: CliContext): void {
  ctx.log(`Job "${s.jobId}": ${s.awaitingReview.length} ready for review, ${s.rejected.length} culled, ${s.failed.length} failed`);
  const reasons = Object.values(s.rejectReasons).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {});
  if (Object.keys(reasons).length) ctx.log(`  culled: ${Object.entries(reasons).map(([r, n]) => `${n} ${r}`).join(", ")}`);
  for (const f of s.failed) ctx.log(`  failed ${f.assetId}: [${f.code}] ${f.message}`);
  for (const [id, fields] of Object.entries(s.unsupported)) ctx.log(`  note ${id}: adapter ignores ${fields.join(", ")}`);
  for (const [id, fields] of Object.entries(s.outliers)) ctx.log(`  check ${id}: differs from the album in ${fields.join(", ")}`);
  for (const [id, job] of Object.entries(s.seenBefore)) ctx.log(`  note ${id}: already processed in job "${job}"`);
  if (s.awaitingReview.length) ctx.log("Run `vivah review` to approve and adjust, or `vivah export` to approve from the command line.");
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "style";
