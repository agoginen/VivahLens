const LABELS: Record<string, string> = {
  queued: "Reading files",
  culled: "Culling",
  "style-matched": "Matching your style",
  "recipe-generated": "Proposing edits",
  review: "Applying edits",
  exported: "Exporting",
  delivered: "Delivering",
  finishing: "Finishing files",
};

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Live progress with an ETA per stage, printed at most every `intervalMs` (and always on completion),
 * so a 1,500-photo batch never looks hung.
 */
export function progressPrinter(log: (line: string) => void, intervalMs = 2000, now: () => number = Date.now) {
  let stage: string | undefined;
  let startedAt = 0;
  let lastPrint = 0;
  return (e: { stage: string; done: number; total: number }): void => {
    const t = now();
    if (e.stage !== stage) {
      stage = e.stage;
      startedAt = t;
      lastPrint = 0;
    }
    const complete = e.done >= e.total;
    if (!complete && t - lastPrint < intervalMs) return;
    lastPrint = t;
    const elapsed = (t - startedAt) / 1000;
    const eta = !complete && e.done > 0 ? ` · ETA ${formatDuration((elapsed / e.done) * (e.total - e.done))}` : "";
    log(`  ${LABELS[e.stage] ?? e.stage}: ${e.done}/${e.total}${complete ? ` done in ${formatDuration(elapsed)}` : eta}`);
  };
}
