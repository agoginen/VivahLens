import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { readRecentLogs, redactValue, stripDirectories, summarizeOutbound, type JobStore, type LibraryStore, type LogRecord, type ProcessRunner } from "@vivahlens/core";
import { runDoctor, type Check } from "./doctor.js";
import { APP_VERSION, logsDir } from "./logging.js";

export const BUNDLE_FORMAT = "vivah-diagnostics/1";

export interface SystemInfo {
  platform: string;
  release: string;
  arch: string;
  node: string;
  cpus: number;
  memoryGb: number;
  locale: string;
}

export interface DiagnosticsDeps {
  env: Record<string, string | undefined>;
  run: ProcessRunner;
  /** With a job id, the bundle describes that job: how many photos are in each state and which errors happened. */
  store?: JobStore & LibraryStore;
  jobId?: string;
  /** The photo folder, so its name is hidden wherever it appears. */
  folder?: string;
  now?: () => Date;
  home?: string;
  system?: SystemInfo;
  maxLogRecords?: number;
  /** Mixed into the stand-in names; random per bundle so two bundles cannot be matched up by them. */
  salt?: string;
}

export interface JobDiagnostics {
  id: string;
  adapter: string;
  style: string;
  photos: number;
  states: Record<string, number>;
  errors: { code: string; count: number; stages: string[]; example: string }[];
  audit: { at: string; action: string; meta?: Record<string, unknown> }[];
  outbound: ReturnType<typeof summarizeOutbound>;
  undo: { recorded: number; notUndoneYet: number };
  deliveries: number;
}

export interface DiagnosticsBundle {
  format: typeof BUNDLE_FORMAT;
  createdAt: string;
  app: { version: string };
  system: SystemInfo;
  checks: Check[];
  job?: JobDiagnostics;
  logs: LogRecord[];
  notes: string[];
}

const NOTES = [
  "This file was written on this computer. Nothing has been sent anywhere; you decide whether to send it.",
  "It holds: versions, the results of `vivah doctor`, how many photos are in each state, error codes and messages, what model providers were asked (counts and sizes), and the recent log.",
  "It does not hold: photos or previews, API keys or tokens, your account or e-mail, your folders' names, or the names of your photos, jobs and styles (each appears as a stand-in such as photo-1a2b3c4d, the same one wherever it occurs).",
];

const AUDIT_LIMIT = 60;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function systemInfo(): SystemInfo {
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    node: process.versions.node,
    cpus: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  };
}

/**
 * Everything support needs to see why "my edits stopped applying" (plan §7.6, §7g), with nothing personal in it: names
 * of photos, jobs, styles and folders become stand-ins, folders are cut off paths, and secrets, e-mail addresses and the
 * account's name are removed by the same redaction the log uses.
 */
export async function buildDiagnostics(deps: DiagnosticsDeps): Promise<DiagnosticsBundle> {
  const home = deps.home ?? os.homedir();
  const salt = deps.salt ?? randomBytes(8).toString("hex");
  const standIns = new Map<string, string>();
  const hide = (kind: string, value: string | undefined, keepExtension = false) => {
    if (!value || standIns.has(value)) return value ?? "";
    const stamp = createHash("sha256").update(`${salt}|${value}`).digest("hex").slice(0, 8);
    // A photo's file type (CR3, JPG) says what kind of file failed, which support needs; the name itself is hidden.
    const extension = keepExtension ? /\.[A-Za-z0-9]{1,5}$/.exec(value)?.[0] ?? "" : "";
    standIns.set(value, `${kind}-${stamp}${extension}`);
    return standIns.get(value)!;
  };

  let job: JobDiagnostics | undefined;
  if (deps.store && deps.jobId) {
    const { store, jobId } = deps;
    const meta = store.getJob(jobId);
    const items = store.listItems(jobId);
    hide("job", jobId);
    hide("job", meta?.name);
    hide("style", meta?.styleProfileId);
    for (const item of items) hide("photo", item.assetId, true);

    const states: Record<string, number> = {};
    const errors = new Map<string, { code: string; count: number; stages: Set<string>; example: string }>();
    for (const item of items) {
      states[item.state] = (states[item.state] ?? 0) + 1;
      if (item.state === "failed") {
        const code = item.errorCode ?? "UNKNOWN";
        const entry = errors.get(code) ?? { code, count: 0, stages: new Set<string>(), example: item.errorMessage ?? "" };
        entry.count++;
        if (item.failedFrom) entry.stages.add(item.failedFrom);
        errors.set(code, entry);
      }
    }
    const undo = store.listUndo(jobId);
    job = {
      id: jobId,
      adapter: meta?.adapterId ?? "unknown",
      style: meta?.styleProfileId ?? "unknown",
      photos: items.length,
      states,
      errors: [...errors.values()].map((e) => ({ code: e.code, count: e.count, stages: [...e.stages].sort(), example: e.example })),
      audit: store.listAudit({ jobId }).slice(-AUDIT_LIMIT).map((a) => ({ at: a.at, action: a.action, ...(a.meta && { meta: a.meta }) })),
      outbound: summarizeOutbound(store.listOutbound({ jobId })),
      undo: { recorded: undo.length, notUndoneYet: undo.filter((u) => u.undoneAt === undefined).length },
      deliveries: store.listDeliveries(jobId).length,
    };
  }
  if (deps.folder) hide("folder", path.basename(path.resolve(deps.folder)));

  const names = [...standIns.keys()].sort((a, b) => b.length - a.length);
  // A name is replaced only where it stands alone, so a short one cannot damage the words around it.
  const pattern = names.length ? new RegExp(`(?<![A-Za-z0-9])(?:${names.map(escapeRegExp).join("|")})(?![A-Za-z0-9])`, "g") : undefined;
  const transform = (text: string) => {
    const bare = stripDirectories(text);
    return pattern ? bare.replace(pattern, (name) => standIns.get(name) ?? name) : bare;
  };

  const maxLogRecords = deps.maxLogRecords ?? 300;
  // Names are replaced only in what comes from the person's own work (the job and the log). The checks are our own
  // wording, and a job called "RAW" must not rewrite "edits RAW files" in them.
  const own = { home, transform, maxArray: Math.max(1000, maxLogRecords), maxString: 600 };
  const ours = { home, transform: stripDirectories, maxString: 600 };
  return {
    format: BUNDLE_FORMAT,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    app: { version: APP_VERSION },
    system: deps.system ?? systemInfo(),
    checks: redactValue(await runDoctor({ env: deps.env, run: deps.run, home }), ours) as Check[],
    ...(job && { job: redactValue(job, own) as JobDiagnostics }),
    logs: redactValue(await readRecentLogs(logsDir(deps.env), { maxRecords: maxLogRecords }), own) as LogRecord[],
    notes: NOTES,
  };
}
