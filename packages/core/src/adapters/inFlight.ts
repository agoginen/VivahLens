import type { AdapterContext } from "./editorAdapter.js";

export interface InFlightWork {
  /** Aborts when the job is cancelled, through `cancel(jobId)` or through the job's own signal. */
  signal: AbortSignal;
  /** Call when the work is over, however it ended. */
  release: () => void;
}

/**
 * The work an adapter has queued or started, per job, so that `cancel(jobId)` reaches all of it.
 * Work is entered before its first wait: a cancel that comes while it is queued or still preparing is kept, not lost.
 */
export class InFlightJobs {
  private readonly byJob = new Map<string, Set<AbortController>>();

  enter(ctx?: AdapterContext): InFlightWork {
    const controller = new AbortController();
    const key = ctx?.jobId ?? "";
    this.byJob.set(key, (this.byJob.get(key) ?? new Set()).add(controller));
    const onAbort = () => controller.abort();
    // A listener added after the signal has fired is never called.
    if (ctx?.signal?.aborted) controller.abort();
    else ctx?.signal?.addEventListener("abort", onAbort, { once: true });
    return {
      signal: controller.signal,
      release: () => {
        ctx?.signal?.removeEventListener("abort", onAbort);
        const work = this.byJob.get(key);
        work?.delete(controller);
        if (work?.size === 0) this.byJob.delete(key);
      },
    };
  }

  cancel(jobId: string): void {
    for (const controller of this.byJob.get(jobId) ?? []) controller.abort();
  }
}
