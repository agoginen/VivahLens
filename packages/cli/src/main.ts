#!/usr/bin/env node
import { runCli } from "./commands.js";
import { openInBrowser } from "./openBrowser.js";

// No top-level await: a bundler that emits CommonJS (as a single-executable build needs) cannot compile one.
async function main(): Promise<void> {
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());

  process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    log: (line) => console.log(line),
    info: (line) => console.error(line),
    signal: abort.signal,
    openUrl: async (url) => {
      const outcome = await openInBrowser(url);
      if (!outcome.opened) throw new Error(outcome.reason);
    },
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
