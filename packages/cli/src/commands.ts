import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { RawTherapeeAdapter } from "@vivahlens/adapter-rawtherapee";
import { XmpSidecarAdapter } from "@vivahlens/adapter-xmp";
import {
  exportApproved,
  learnStyle,
  runJob,
  SqliteJobStore,
  StyleProfileSchema,
  VivahError,
  type EditorAdapter,
  type ReviewSummary,
} from "@vivahlens/core";
import { loadGray, loadPreview, scanFolder } from "@vivahlens/ingest";
import { buildGateway, type ProviderChoice } from "./providers.js";

export interface CliContext {
  env: Record<string, string | undefined>;
  log(line: string): void;
}

const USAGE = `vivah: AI editing automation (local-first)

  vivah learn  --refs <dir> --name <style> [--out profile.json]      learn a style from finished photos
  vivah edit   --folder <dir> --profile <file> [--adapter xmp|rawtherapee]
                                                                    cull, propose and apply edits, then stop for review
  vivah export --folder <dir> (--approve a.cr3,b.cr3 | --approve-all) --export-dir <dir>
                                                                    export photos you approved

Common: --provider mock|openai|anthropic|ollama|openai-compatible  --model <id>  [--base-url <url>]  [--max-cost <usd>]
        --db <file>  --job <id>  --concurrency <n>  --retry-failed
Keys are read from OPENAI_API_KEY / ANTHROPIC_API_KEY / VIVAH_API_KEY; RAWTHERAPEE_CLI overrides the rawtherapee-cli path.
Only downscaled JPEG previews (no EXIF/GPS) are sent to the LLM; originals are never modified or uploaded.`;

const MAX_REFERENCES = 10;

const OPTIONS = {
  refs: { type: "string" },
  name: { type: "string" },
  out: { type: "string" },
  folder: { type: "string" },
  profile: { type: "string" },
  adapter: { type: "string", default: "xmp" },
  db: { type: "string" },
  job: { type: "string" },
  concurrency: { type: "string" },
  "max-cost": { type: "string" },
  "retry-failed": { type: "boolean" },
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
      case "export":
        return await exportCmd(values, ctx);
      default:
        ctx.log(`Unknown command "${command}"\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
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
  };
}

function makeAdapter(name: string, env: CliContext["env"]): EditorAdapter {
  if (name === "xmp") return new XmpSidecarAdapter();
  if (name === "rawtherapee") return new RawTherapeeAdapter({ binary: env.RAWTHERAPEE_CLI });
  throw new Error(`Unknown adapter "${name}". Use xmp or rawtherapee.`);
}

async function openStore(v: Args): Promise<SqliteJobStore> {
  const file = v.db ?? path.join(os.homedir(), ".vivahlens", "jobs.db");
  await fs.mkdir(path.dirname(file), { recursive: true });
  return new SqliteJobStore(file);
}

const jobId = (v: Args, folder: string) => v.job ?? path.basename(path.resolve(folder));

async function learn(v: Args, ctx: CliContext): Promise<number> {
  const refsDir = need(v.refs, "refs");
  const name = need(v.name, "name");
  const refs = (await scanFolder(refsDir)).slice(0, MAX_REFERENCES);
  if (refs.length === 0) throw new Error(`No supported images found in ${refsDir}`);

  ctx.log(`Sending ${refs.length} downscaled preview(s) to "${v.provider}" to learn the style…`);
  const gateway = buildGateway(providerChoice(v), ctx.env);
  const previews = await Promise.all(refs.map((a) => loadPreview(a)));
  const profile = await learnStyle(gateway, { id: slug(name), name, references: previews });

  const out = v.out ?? `${slug(name)}.profile.json`;
  await fs.writeFile(out, JSON.stringify(StyleProfileSchema.parse(profile), null, 2), "utf8");
  ctx.log(`Style "${name}" saved to ${out}\n  ${profile.summary}`);
  return 0;
}

async function edit(v: Args, ctx: CliContext): Promise<number> {
  const folder = need(v.folder, "folder");
  const profile = StyleProfileSchema.parse(JSON.parse(await fs.readFile(need(v.profile, "profile"), "utf8")));
  const adapter = makeAdapter(v.adapter ?? "xmp", ctx.env);
  if (!(await adapter.detect())) throw new VivahError("ADAPTER_EDITOR_NOT_RUNNING", `${adapter.id} was not found on this machine`);

  const assets = await scanFolder(folder);
  if (assets.length === 0) throw new Error(`No supported images found in ${folder}`);
  const gateway = buildGateway(providerChoice(v), ctx.env);
  const store = await openStore(v);

  ctx.log(`Editing ${assets.length} photo(s) with "${adapter.id}". Previews (≤2048px, EXIF/GPS stripped) go to "${v.provider}"; originals stay put.`);
  try {
    const summary = await runJob(
      {
        store,
        gateway,
        adapter,
        profile,
        previewOf: (a) => loadPreview(a),
        grayOf: (a) => loadGray(a),
        concurrency: v.concurrency ? Number(v.concurrency) : undefined,
      },
      { id: jobId(v, folder), name: path.basename(folder), assets, retryFailed: v["retry-failed"] },
    );
    printSummary(summary, ctx);
    const usage = gateway.usage();
    ctx.log(`LLM calls: ${usage.calls}, tokens in/out: ${usage.inputTokens}/${usage.outputTokens}`);
    return summary.failed.length > 0 ? 2 : 0;
  } finally {
    store.close();
  }
}

async function exportCmd(v: Args, ctx: CliContext): Promise<number> {
  const folder = need(v.folder, "folder");
  const exportDir = need(v["export-dir"], "export-dir");
  if (!v["approve-all"] && !v.approve) throw new Error("Nothing approved: pass --approve <ids> or --approve-all after reviewing");
  const adapter = makeAdapter(v.adapter ?? "xmp", ctx.env);
  if (!adapter.export) {
    ctx.log(`The "${adapter.id}" adapter writes edits only; export from your editor (e.g. Lightroom) after reading metadata.`);
    return 1;
  }
  const store = await openStore(v);
  try {
    const id = jobId(v, folder);
    const approve = v["approve-all"]
      ? store.listItems(id).filter((i) => i.state === "review").map((i) => i.assetId)
      : v.approve!.split(",").map((s) => s.trim());
    const result = await exportApproved(
      { store, adapter },
      id,
      await scanFolder(folder),
      { approve, exportSpec: { format: v.format === "tiff" ? "tiff" : "jpeg", quality: v.quality ? Number(v.quality) : undefined, outputDir: exportDir } },
    );
    ctx.log(`Exported ${result.exported.length} photo(s) to ${exportDir}`);
    for (const f of result.failed) ctx.log(`  failed ${f.assetId}: [${f.code}] ${f.message}`);
    return result.failed.length > 0 ? 2 : 0;
  } finally {
    store.close();
  }
}

function printSummary(s: ReviewSummary, ctx: CliContext): void {
  ctx.log(`Job "${s.jobId}": ${s.awaitingReview.length} ready for review, ${s.rejected.length} culled, ${s.failed.length} failed`);
  for (const f of s.failed) ctx.log(`  failed ${f.assetId}: [${f.code}] ${f.message}`);
  for (const [id, fields] of Object.entries(s.unsupported)) ctx.log(`  note ${id}: adapter ignores ${fields.join(", ")}`);
  if (s.awaitingReview.length) ctx.log("Review the edits in your editor, then run `vivah export` for the ones you approve.");
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "style";
