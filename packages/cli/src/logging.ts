import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createLogger, nullLogger, openLogFile, type Logger, type LogLevel } from "@vivahlens/core";
import { dataDir } from "./paths.js";

export const logsDir = (env: Record<string, string | undefined>): string => path.join(dataDir(env), "logs");

declare const __VIVAH_VERSION__: string | undefined;

/** The version of this build, for logs and the support bundle. */
export const APP_VERSION: string = (() => {
  // The single-file build has no package.json beside it, so its build script puts the version in.
  if (typeof __VIVAH_VERSION__ === "string") return __VIVAH_VERSION__;
  try {
    return (createRequire(import.meta.url)("../package.json") as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

export interface CommandLog {
  logger: Logger;
  /** Waits until everything logged so far is in the file. */
  close(): Promise<void>;
}

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * The structured log for one command (plan §7.6), in `logs/` under the data folder. `VIVAH_LOG_LEVEL` picks how much
 * is kept (debug, info, warn, error; default info). A log that cannot be opened never stops the command: it runs
 * without one and says so.
 */
export async function openCommandLog(env: Record<string, string | undefined>, command: string, say: (line: string) => void): Promise<CommandLog> {
  const wanted = env.VIVAH_LOG_LEVEL?.toLowerCase();
  const level = LEVELS.find((l) => l === wanted) ?? "info";
  if (wanted && wanted !== level) say(`VIVAH_LOG_LEVEL "${env.VIVAH_LOG_LEVEL}" is not one of ${LEVELS.join(", ")}; using "info".`);
  try {
    const file = await openLogFile({ dir: logsDir(env) });
    const logger = createLogger({ write: file.write, level, redact: { home: os.homedir() }, base: { command, pid: process.pid, version: APP_VERSION } });
    logger.info("command-started");
    return { logger, close: () => file.flush() };
  } catch (err) {
    say(`Logs are not being kept: ${err instanceof Error ? err.message : String(err)}`);
    return { logger: nullLogger, close: async () => undefined };
  }
}
