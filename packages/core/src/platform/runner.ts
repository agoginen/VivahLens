import { spawn } from "node:child_process";

export interface RunOptions {
  /** Written to the child's standard input, then closed. Secrets travel this way and never on a command line. */
  stdin?: Uint8Array | string;
  /** The child is killed after this long. */
  timeoutMs?: number;
  /** Added to the environment (non-secret values only: process environments are readable by the user's other programs). */
  env?: Record<string, string>;
}

export interface RunResult {
  /** The exit code; null when the program could not be started or was killed. */
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  /** Why the program could not be started (it is not installed, say). */
  startError?: string;
}

/** Starts a program with no shell, so nothing in the arguments can be interpreted. A seam: tests supply a fake. */
export type Runner = (command: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>;

const MAX_OUTPUT = 4 * 1024 * 1024;

export const nodeRunner: Runner = (command, args, opts = {}) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, [...args], { shell: false, windowsHide: true, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: "", timedOut: false, startError: err instanceof Error ? err.message : String(err) });
      return;
    }
    const out: Buffer[] = [];
    let outSize = 0;
    let stderr = "";
    let timedOut = false;
    let startError: string | undefined;
    const timer = opts.timeoutMs ? setTimeout(() => ((timedOut = true), child.kill()), opts.timeoutMs) : undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      outSize += chunk.length;
      if (outSize <= MAX_OUTPUT) out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => (startError = err.message));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: startError ? null : code, stdout: Buffer.concat(out), stderr, timedOut, ...(startError && { startError }) });
    });
    // A child that exits without reading its input closes the pipe; that is not an error here.
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin === undefined ? undefined : typeof opts.stdin === "string" ? Buffer.from(opts.stdin, "utf8") : Buffer.from(opts.stdin));
  });

/** A fake for tests: answers from a script and records every call, so a test can prove a secret never reached an argument list. */
export interface ScriptedStep {
  when(command: string, args: readonly string[], opts: RunOptions): boolean;
  reply: Partial<RunResult> | ((command: string, args: readonly string[], opts: RunOptions) => Partial<RunResult>);
}

export function scriptedRunner(script: readonly ScriptedStep[]): { run: Runner; calls: { command: string; args: readonly string[]; opts: RunOptions }[] } {
  const calls: { command: string; args: readonly string[]; opts: RunOptions }[] = [];
  const run: Runner = async (command, args, opts = {}) => {
    calls.push({ command, args, opts });
    const step = script.find((s) => s.when(command, args, opts));
    if (!step) throw new Error(`unscripted call: ${command} ${args.join(" ")}`);
    const reply = typeof step.reply === "function" ? step.reply(command, args, opts) : step.reply;
    return { code: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, ...reply };
  };
  return { run, calls };
}
