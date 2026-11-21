import { execFile } from "node:child_process";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Seam for launching CLI editors, so adapters are testable without the real binary installed. */
export type ProcessRunner = (command: string, args: readonly string[], opts?: { signal?: AbortSignal }) => Promise<ProcessResult>;

export const runProcess: ProcessRunner = (command, args, opts) =>
  new Promise((resolve) => {
    execFile(command, [...args], { signal: opts?.signal, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout, stderr: err && typeof err.code !== "number" ? `${stderr}${err.message}` : stderr });
    });
  });
