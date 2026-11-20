import { PROTOCOL_VERSION, type OpName, type WorkerErrorCode, type WorkerOps, type WorkerRequest, type WorkerResponse } from "../protocol";

export class WorkerJobError extends Error {
  constructor(readonly code: WorkerErrorCode | "CANCELLED" | "WORKER_CRASHED") {
    super(code);
    this.name = "WorkerJobError";
  }
}

export interface RunOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number, stage?: string) => void;
}

/**
 * Minimal main-thread client for one dependency-specific worker. The worker is created
 * lazily on first use so its dependencies (e.g. OpenCV) cost 0 bytes until then.
 * Seed of the future WorkerBroker (architecture §24).
 */
export function createWorkerClient(factory: () => Worker) {
  let worker: Worker | null = null;
  let seq = 0;
  const pending = new Map<string, { resolve(v: unknown): void; reject(e: unknown): void; onProgress?: RunOptions["onProgress"]; signal?: AbortSignal; cleanup(): void }>();
  const releasePreview = (msg: WorkerResponse) => {
    if (msg.type === "SUCCESS" && msg.jobId.startsWith("image.preview:")) (msg.output as WorkerOps["image.preview"]["output"]).bitmap.close();
  };

  const ensure = () => {
    if (worker) return worker;
    const current = factory();
    worker = current;
    current.addEventListener("message", (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (worker !== current) { releasePreview(msg); return; }
      const job = pending.get(msg.jobId);
      if (!job) { releasePreview(msg); return; }
      if (msg.type === "PROGRESS") return !job.signal?.aborted && job.onProgress?.(msg.progress, msg.stage);
      pending.delete(msg.jobId);
      job.cleanup();
      if (job.signal?.aborted) { releasePreview(msg); job.reject(new WorkerJobError("CANCELLED")); }
      else if (msg.type === "SUCCESS") job.resolve(msg.output);
      else if (msg.type === "CANCELLED") job.reject(new WorkerJobError("CANCELLED"));
      else job.reject(new WorkerJobError(msg.code));
    });
    current.addEventListener("error", (event) => {
      // Handled here — every waiting job is rejected — so it must not also surface as an
      // uncaught page error (e.g. a worker script whose load the page's teardown cancelled).
      event.preventDefault();
      // An error queued by a retired worker belongs to that instance, not its replacement.
      if (worker !== current) return;
      for (const job of pending.values()) { job.cleanup(); job.reject(new WorkerJobError("WORKER_CRASHED")); }
      pending.clear();
      current.terminate();
      worker = null;
    });
    return current;
  };

  return {
    run<K extends OpName>(op: K, input: WorkerOps[K]["input"], opts: RunOptions = {}): Promise<WorkerOps[K]["output"]> {
      if (opts.signal?.aborted) return Promise.reject(new WorkerJobError("CANCELLED"));
      const w = ensure();
      const jobId = `${op}:${++seq}`;
      return new Promise((resolve, reject) => {
        const cancel = () => {
          try { w.postMessage({ version: PROTOCOL_VERSION, jobId, type: "CANCEL" } satisfies WorkerRequest); }
          catch { pending.delete(jobId); cleanup(); reject(new WorkerJobError("CANCELLED")); }
        };
        const cleanup = () => opts.signal?.removeEventListener("abort", cancel);
        pending.set(jobId, { resolve: resolve as (v: unknown) => void, reject, onProgress: opts.onProgress, signal: opts.signal, cleanup });
        opts.signal?.addEventListener("abort", cancel, { once: true });
        try { w.postMessage({ version: PROTOCOL_VERSION, jobId, type: "RUN", op, input } as WorkerRequest); }
        catch { pending.delete(jobId); cleanup(); reject(new WorkerJobError("WORKER_CRASHED")); }
      });
    },
    /** Terminate this instance and cancel its pending jobs. */
    terminate() {
      worker?.terminate();
      worker = null;
      for (const job of pending.values()) { job.cleanup(); job.reject(new WorkerJobError("CANCELLED")); }
      pending.clear();
    },
  };
}
