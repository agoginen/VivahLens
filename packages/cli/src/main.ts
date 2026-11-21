#!/usr/bin/env node
import { runCli } from "./commands.js";

const abort = new AbortController();
process.once("SIGINT", () => abort.abort());

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  log: (line) => console.log(line),
  info: (line) => console.error(line),
  signal: abort.signal,
});
