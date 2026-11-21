#!/usr/bin/env node
import { runCli } from "./commands.js";

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  log: (line) => console.log(line),
});
