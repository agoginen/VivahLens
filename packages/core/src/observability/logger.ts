import { redactValue, type RedactOptions } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that adds these fields to everything it writes (a job id, an adapter). */
  child(fields: LogFields): Logger;
}

export interface LogRecord {
  ts: string;
  level: LogLevel;
  event: string;
  [field: string]: unknown;
}

export interface LoggerOptions {
  /** Receives one JSON object per call, already redacted. */
  write(line: string): void;
  /** The lowest level written (default "info"). */
  level?: LogLevel;
  now?: () => Date;
  /** Fields on every record. */
  base?: LogFields;
  redact?: RedactOptions;
}

const RESERVED = new Set(["ts", "level", "event"]);

/**
 * Structured logging for the pipeline (plan §7.6): one JSON record per event with job id, adapter, recipe hash, model,
 * latency and outcome. Every field passes through `redactValue`, so a log never holds a key, a token, image data or the
 * account's name; and logging never throws into the work it describes.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const minimum = RANK[opts.level ?? "info"];
  const make = (base: LogFields): Logger => {
    const emit = (level: LogLevel) => (event: string, fields: LogFields = {}) => {
      if (RANK[level] < minimum) return;
      try {
        const body = redactValue({ ...base, ...fields }, opts.redact) as LogFields;
        const record: LogRecord = { ts: (opts.now?.() ?? new Date()).toISOString(), level, event };
        for (const [key, value] of Object.entries(body)) if (!RESERVED.has(key)) record[key] = value;
        opts.write(JSON.stringify(record));
      } catch {
        // A log that cannot be written is not worth failing a photographer's batch over.
      }
    };
    return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error"), child: (more) => make({ ...base, ...more }) };
  };
  return make(opts.base ?? {});
}

export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return nullLogger;
  },
};

/** A logger that keeps what it is told, for tests and for the support bundle's in-memory view. */
export function memoryLogger(opts: Omit<LoggerOptions, "write"> = {}): Logger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const logger = createLogger({ level: "debug", ...opts, write: (line) => records.push(JSON.parse(line) as LogRecord) });
  return Object.assign(logger, { records });
}
