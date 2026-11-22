import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, type ResourceLimits } from "node:worker_threads";
import { embeddedAsset, VivahError, type AssetRef, type ErrorCode, type Preview } from "@vivahlens/core";
import type { Analysis } from "./images.js";
import type { WorkerReply, WorkerRequest } from "./decodeWorker.js";

export interface DecodePoolOptions {
  /** How many decoders run at once (default: one fewer than the computer's cores, at most 6, at least 1). */
  size?: number;
  /** Memory limits for each decoder. A hostile or broken image that exhausts them stops its own decoder, not the agent. */
  resourceLimits?: ResourceLimits;
  /** The worker script to run; the compiled decoder by default. Tests give one that misbehaves. */
  workerFile?: string;
  /** The worker as CommonJS source, for a build that has no files beside the program (the single executable embeds it). */
  workerCode?: string;
}

const WORKER_FILE = fileURLToPath(new URL("./decodeWorker.js", import.meta.url));
const EMBEDDED_WORKER = "ingest/decodeWorker.cjs";
const DEFAULT_LIMITS: ResourceLimits = { maxOldGenerationSizeMb: 1536 };

interface Task {
  id: number;
  request: WorkerRequest;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface Slot {
  worker: Worker;
  task?: Task;
}

/** The default number of decoders for this computer: leave a core for the agent itself and the editor. */
export function defaultDecodeWorkers(): number {
  return Math.max(1, Math.min(6, os.availableParallelism() - 1));
}

/**
 * Decodes photos on worker threads. Decoding a camera preview is pure JavaScript and takes most of the time of a batch
 * (about a second a photo on one core), so spreading it over cores is what makes a 500-photo job finish in minutes
 * (plan §7h). It also keeps a damaged or hostile file away from the agent: a decoder that runs out of memory or dies
 * fails that one photo with ASSET_UNREADABLE and is replaced. The pool is a speed-up, never a requirement: it exists only
 * when the compiled worker is present, and callers fall back to decoding in the same thread.
 */
export class DecodePool {
  private readonly slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private nextId = 1;
  private closed = false;
  private readonly size: number;
  private readonly limits: ResourceLimits;
  private readonly workerFile: string;
  private readonly workerCode: string | undefined;

  constructor(opts: DecodePoolOptions = {}) {
    this.size = Math.max(1, opts.size ?? defaultDecodeWorkers());
    this.limits = { ...DEFAULT_LIMITS, ...opts.resourceLimits };
    this.workerFile = opts.workerFile ?? WORKER_FILE;
    this.workerCode = opts.workerCode ?? (opts.workerFile === undefined ? embeddedAsset(EMBEDDED_WORKER)?.toString("utf8") : undefined);
  }

  /** Whether a decoder is there to start: the compiled worker in a built install, or the one embedded in the single executable. Not when running from TypeScript source. */
  static available(): boolean {
    return embeddedAsset(EMBEDDED_WORKER) !== undefined || existsSync(WORKER_FILE);
  }

  analysis(asset: AssetRef, opts?: { maxEdge?: number }): Promise<Analysis> {
    return this.submit("analysis", asset, opts) as Promise<Analysis>;
  }

  preview(asset: AssetRef, opts?: { maxEdge?: number; quality?: number }): Promise<Preview> {
    return this.submit("preview", asset, opts) as Promise<Preview>;
  }

  private submit(op: WorkerRequest["op"], asset: AssetRef, opts?: WorkerRequest["opts"]): Promise<unknown> {
    if (this.closed) return Promise.reject(new VivahError("ASSET_UNREADABLE", "The decoder pool has been closed"));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, request: { id: 0, op, asset: { id: asset.id, kind: "photo", path: asset.path }, ...(opts && { opts }) }, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.queue.length > 0) {
      let slot = this.slots.find((s) => s.task === undefined);
      if (!slot && this.slots.length < this.size) {
        slot = this.start();
      }
      if (!slot) return;
      const task = this.queue.shift()!;
      slot.task = task;
      slot.worker.postMessage({ ...task.request, id: task.id } satisfies WorkerRequest);
    }
  }

  private start(): Slot {
    const worker = this.workerCode !== undefined ? new Worker(this.workerCode, { eval: true, resourceLimits: this.limits }) : new Worker(this.workerFile, { resourceLimits: this.limits });
    const slot: Slot = { worker };
    this.slots.push(slot);
    worker.on("message", (reply: WorkerReply) => {
      const task = slot.task;
      if (!task || task.id !== reply.id) return;
      slot.task = undefined;
      if (reply.ok) task.resolve(reply.result);
      else task.reject(new VivahError(reply.code as ErrorCode, reply.message));
      this.pump();
    });
    const died = (why: string) => {
      const index = this.slots.indexOf(slot);
      if (index === -1) return;
      this.slots.splice(index, 1);
      const task = slot.task;
      slot.task = undefined;
      task?.reject(new VivahError("ASSET_UNREADABLE", `The image decoder stopped while reading ${path.basename(task.request.asset.path)} (${why}); it may be damaged`));
      if (!this.closed) this.pump();
    };
    worker.on("error", (err) => died(err.message));
    worker.on("exit", (code) => died(`exit code ${code}`));
    return slot;
  }

  /** Stops every decoder. Photos still waiting fail; call it when the job is done. */
  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.queue.splice(0)) task.reject(new VivahError("ASSET_UNREADABLE", "The decoder pool has been closed"));
    await Promise.all(this.slots.splice(0).map(async (slot) => {
      slot.task?.reject(new VivahError("ASSET_UNREADABLE", "The decoder pool has been closed"));
      slot.task = undefined;
      await slot.worker.terminate();
    }));
  }
}
