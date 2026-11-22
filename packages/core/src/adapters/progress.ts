import type { ProgressEvent } from "./editorAdapter.js";

/**
 * Fan-out for an adapter's progress events. Subscribers see every event emitted after they subscribe, in order, and
 * a slow consumer never blocks the adapter. Events without a job id reach every subscriber.
 */
export class ProgressChannel {
  private readonly subscribers = new Set<(event: ProgressEvent | undefined) => void>();

  emit(event: ProgressEvent): void {
    for (const push of [...this.subscribers]) push(event);
  }

  /** Events for `jobId` (all events when omitted) until `close()` is called or the consumer stops iterating. */
  subscribe(jobId?: string): AsyncIterable<ProgressEvent> {
    const queue: ProgressEvent[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const push = (event: ProgressEvent | undefined) => {
      if (event === undefined) closed = true;
      else if (!jobId || !event.jobId || event.jobId === jobId) queue.push(event);
      wake?.();
    };
    this.subscribers.add(push);
    const leave = () => void this.subscribers.delete(push);
    return {
      [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<ProgressEvent>> {
          while (queue.length === 0 && !closed) await new Promise<void>((resolve) => (wake = resolve));
          if (queue.length > 0) return { value: queue.shift()!, done: false };
          leave();
          return { value: undefined, done: true };
        },
        async return(): Promise<IteratorResult<ProgressEvent>> {
          closed = true;
          leave();
          return { value: undefined, done: true };
        },
      }),
    };
  }

  /** Ends every subscription once the events already queued have been read. */
  close(): void {
    const all = [...this.subscribers];
    this.subscribers.clear();
    for (const push of all) push(undefined);
  }
}
