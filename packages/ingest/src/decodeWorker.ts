import { parentPort } from "node:worker_threads";
import { VivahError } from "@vivahlens/core";
import { loadAnalysis, loadPreview } from "./images.js";

/** What a pool worker is asked to do, and how it answers. See `DecodePool`. */
export interface WorkerRequest {
  id: number;
  op: "analysis" | "preview";
  asset: { id: string; kind: "photo"; path: string };
  opts?: { maxEdge?: number; quality?: number };
}

export type WorkerReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; code: string; message: string };

parentPort?.on("message", async (request: WorkerRequest) => {
  try {
    const result = request.op === "analysis" ? await loadAnalysis(request.asset, request.opts) : await loadPreview(request.asset, request.opts);
    parentPort!.postMessage({ id: request.id, ok: true, result } satisfies WorkerReply);
  } catch (err) {
    const code = err instanceof VivahError ? err.code : "ASSET_UNREADABLE";
    parentPort!.postMessage({ id: request.id, ok: false, code, message: err instanceof Error ? err.message : String(err) } satisfies WorkerReply);
  }
});
