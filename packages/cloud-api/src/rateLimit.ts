/** In-memory fixed-window limiter. Fine for a single instance; a multi-instance deployment needs a shared store. */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly now: () => number) {}

  private current(key: string, windowMs: number) {
    const t = this.now();
    if (this.windows.size > 10_000) this.sweep(t);
    let w = this.windows.get(key);
    if (!w || t - w.start >= windowMs) {
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    return { w, retryAfterSec: Math.max(1, Math.ceil((w.start + windowMs - t) / 1000)) };
  }

  /** Counts this attempt; `allowed` is false once more than `limit` attempts happened in the window. */
  hit(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSec: number } {
    const { w, retryAfterSec } = this.current(key, windowMs);
    w.count++;
    return { allowed: w.count <= limit, retryAfterSec };
  }

  /** Reads without counting: true when `limit` or more attempts were already recorded in the window. */
  exhausted(key: string, limit: number, windowMs: number): { blocked: boolean; retryAfterSec: number } {
    const { w, retryAfterSec } = this.current(key, windowMs);
    return { blocked: w.count >= limit, retryAfterSec };
  }

  private sweep(now: number): void {
    for (const [k, w] of this.windows) if (now - w.start > 3_600_000) this.windows.delete(k);
  }
}
