/**
 * Tesseract.js implementation of OcrEngine — the ONLY module that talks to Tesseract.
 *
 * - Tesseract.js runs recognition in its own dedicated Web Worker (browser) or
 *   worker_thread (Node). This adapter keeps ONE worker and reuses it across jobs.
 * - `createWorker` is injected so the module is lazily loaded and testable.
 * - Jobs are serialised. Cancellation = terminate the worker (Tesseract has no per-job
 *   abort); the next job transparently re-initialises from cache.
 */
import { OcrError, toOcrError } from "./errors";
import { buildResult, normalizeTesseractBlocks, type CleanupOptions, type TesseractBlock } from "./normalize";
import type { OcrEngine, OcrInitOptions, OcrInput, OcrLanguage, OcrOptions, OcrResult, PageSegmentation } from "./types";

/** Structural subset of the tesseract.js API we depend on. */
export interface TesseractWorkerLike {
  recognize(
    image: unknown,
    options?: Record<string, unknown>,
    output?: Record<string, boolean>,
  ): Promise<{ data: { text: string; blocks: TesseractBlock[] | null; confidence: number; rotateRadians?: number } }>;
  setParameters(params: Record<string, string>): Promise<unknown>;
  reinitialize(langs: string, oem?: number): Promise<unknown>;
  terminate(): Promise<unknown>;
}

export type CreateWorker = (
  langs: string,
  oem: number,
  options: Record<string, unknown>,
) => Promise<TesseractWorkerLike>;

export interface TesseractEngineConfig {
  createWorker: CreateWorker;
  /** Self-hosted asset locations (browser). Omit in Node except langPath. */
  workerPath?: string;
  corePath?: string;
  langPath: string;
  /** "write" caches decompressed models in IndexedDB (browser); "none" disables. */
  cacheMethod?: "write" | "readOnly" | "refresh" | "none";
  version: string;
  cleanup?: CleanupOptions;
  /**
   * Fail initialisation after this long (ms). Spike C: a missing core/model can make
   * Tesseract.js' createWorker never settle (the error is raised inside its worker).
   */
  initTimeoutMs?: number;
  /** Cheap reachability check for core/model assets before creating the worker (browser). */
  preflight?: (languages: string[], signal?: AbortSignal) => Promise<void>;
}

const PSM: Record<PageSegmentation, string> = { auto: "3", "single-column": "4", "single-block": "6", sparse: "11" };
const OEM_LSTM_ONLY = 1;
// Screenshot files commonly omit physical DPI. Giving Tesseract a stable value prevents
// Leptonica from writing "Estimating resolution" to stderr while keeping recognition
// deterministic across browser engines.
const SCREENSHOT_DPI = "300";

interface Initialization {
  langs: string;
  abort: AbortController;
  promise: Promise<void>;
}

/** Native worker promises may never settle after termination. Always release the waiter. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener("abort", cancel); reject(new OcrError("OCR_CANCELLED")); };
    promise.then((value) => { signal.removeEventListener("abort", cancel); resolve(value); }, (error) => { signal.removeEventListener("abort", cancel); reject(error); });
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
}

export class TesseractEngine implements OcrEngine {
  readonly name = "tesseract.js";
  private worker: TesseractWorkerLike | null = null;
  private langs = "";
  private queue: Promise<unknown> = Promise.resolve();
  private progress: OcrOptions["onProgress"] | null = null;
  private currentPsm = "";
  private initializing: Initialization | null = null;
  private active: AbortController | null = null;
  /** Number of worker (re)creations — exposed for diagnostics/benchmarks. */
  initCount = 0;

  constructor(private readonly cfg: TesseractEngineConfig) {}

  async initialise(options: OcrInitOptions = { languages: ["eng"] }): Promise<void> {
    const langs = [...options.languages].sort().join("+");
    if (this.worker && this.langs === langs) return;
    if (this.initializing?.langs === langs) return this.initializing.promise;
    if (this.worker || this.initializing) {
      // Spike C: Tesseract.js `reinitialize()` leaks engine state across language switches
      // (after eng+hin → eng, rotated/vertical text went from 0.4% to 81% CER). A language
      // change therefore gets a FRESH worker; re-creating from cache costs ~1 s.
      await this.retireWorker();
      // A newer caller may have begun loading while the previous worker was terminating.
      if (this.initializing) {
        if (this.initializing.langs === langs) return this.initializing.promise;
        throw new OcrError("OCR_CANCELLED");
      }
      if (this.worker) {
        if (this.langs === langs) return;
        throw new OcrError("OCR_CANCELLED");
      }
    }
    const pending: Initialization = { langs, abort: new AbortController(), promise: Promise.resolve() };
    this.initializing = pending;
    pending.promise = this.load(pending, options.onProgress);
    return pending.promise;
  }

  private async load(pending: Initialization, onProgress?: OcrInitOptions["onProgress"]): Promise<void> {
    const { langs, abort } = pending;
    let timedOut = false;
    let loaded: TesseractWorkerLike | null = null;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, this.cfg.initTimeoutMs ?? 120_000);
    try {
      await abortable(Promise.resolve().then(() => this.cfg.preflight?.(langs.split("+"), abort.signal)), abort.signal);
      if (abort.signal.aborted) throw new OcrError("OCR_CANCELLED");
      this.initCount++;
      const paths = Object.fromEntries(
        Object.entries({ workerPath: this.cfg.workerPath, corePath: this.cfg.corePath, langPath: this.cfg.langPath }).filter(([, v]) => v !== undefined),
      );
      const creating = this.cfg.createWorker(langs, OEM_LSTM_ONLY, {
        // Only pass defined paths: an explicit `undefined` overrides Tesseract's own defaults.
        ...paths,
        cacheMethod: this.cfg.cacheMethod ?? "write",
        // Load the worker script from our own origin (CSP-friendly, no blob: URLs).
        workerBlobURL: false,
        logger: (m: { status: string; progress: number }) => {
          if (abort.signal.aborted) return;
          if (this.initializing === pending) onProgress?.(m.progress, m.status);
          else if (this.worker === loaded) this.progress?.(m.progress, m.status);
        },
        // Errors still reject the pending promise; this only stops Tesseract re-throwing them
        // as uncaught exceptions on the page.
        errorHandler: () => {},
      });
      const candidate = await abortable(creating.then(async (worker) => {
        if (abort.signal.aborted || this.initializing !== pending) {
          await worker.terminate().catch(() => undefined);
          throw new OcrError("OCR_CANCELLED");
        }
        loaded = worker;
        return worker;
      }), abort.signal);
      if (abort.signal.aborted || this.initializing !== pending) {
        await candidate.terminate().catch(() => undefined);
        throw new OcrError("OCR_CANCELLED");
      }
      this.worker = candidate;
      this.langs = langs;
      this.currentPsm = "";
    } catch (e) {
      if (this.initializing === pending) this.worker = null;
      if (timedOut) throw new OcrError("OCR_ENGINE_LOAD_FAILED", "initialisation timed out");
      const msg = String((e as Error)?.message ?? e);
      throw toOcrError(e, /traineddata|language/i.test(msg) ? "model" : "load");
    } finally {
      clearTimeout(timer);
      if (this.initializing === pending) this.initializing = null;
    }
  }

  recognise(input: OcrInput, options: OcrOptions = {}): Promise<OcrResult> {
    const job = this.queue.then(() => this.run(input, options));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async run(input: OcrInput, options: OcrOptions): Promise<OcrResult> {
    if (options.signal?.aborted) throw new OcrError("OCR_CANCELLED");
    const abort = new AbortController();
    this.active = abort;
    const languages = options.languages ?? (this.langs ? (this.langs.split("+") as OcrLanguage[]) : ["eng"]);
    const onAbort = () => { abort.abort(); if (this.active === abort) void this.retireWorker(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    this.progress = options.onProgress ?? null;
    const t0 = performance.now();
    try {
      await abortable(this.initialise({ languages, onProgress: options.onProgress }), abort.signal);
      if (abort.signal.aborted || !this.worker) throw new OcrError("OCR_CANCELLED");
      const worker = this.worker;
      const psm = PSM[options.segmentation ?? "auto"];
      if (psm !== this.currentPsm) {
        await abortable(worker.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: SCREENSHOT_DPI }), abort.signal);
        this.currentPsm = psm;
      }
      // A terminated Tesseract worker may never settle its pending promise: race the abort.
      const { data } = await abortable(
        worker.recognize(
          input.image,
          options.autoRotate ? { rotateAuto: true } : {},
          // Granular layout output is OPT-IN in Tesseract.js: request it explicitly.
          { text: true, blocks: true },
        ), abort.signal,
      );
      if (abort.signal.aborted) throw new OcrError("OCR_CANCELLED");
      const blocks = normalizeTesseractBlocks(data.blocks, input.transform);
      return buildResult({
        blocks,
        language: this.langs,
        durationMs: performance.now() - t0,
        image: input.original,
        preprocessing: input.preprocessing ?? [],
        engine: { name: this.name, version: this.cfg.version },
        rotateRadians: data.rotateRadians,
        options: { readingOrder: options.readingOrder, preserveIndentation: options.preserveIndentation, cleanup: this.cfg.cleanup },
      });
    } catch (e) {
      if (abort.signal.aborted) throw new OcrError("OCR_CANCELLED");
      const error = toOcrError(e, "recognise");
      // A failed recognition may leave a grown/corrupted WASM heap. Retry on a fresh worker.
      await this.retireWorker();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (this.active === abort) { this.active = null; this.progress = null; }
    }
  }

  /** Stop the running job by terminating the worker. Next job re-initialises. */
  async cancel(): Promise<void> {
    this.active?.abort();
    await this.retireWorker();
  }

  private async retireWorker(): Promise<void> {
    const pending = this.initializing;
    this.initializing = null;
    pending?.abort.abort();
    const w = this.worker;
    this.worker = null;
    this.langs = "";
    this.currentPsm = "";
    await w?.terminate().catch(() => undefined);
  }

  async terminate(): Promise<void> {
    await this.cancel();
  }

  get isLoaded(): boolean {
    return this.worker !== null;
  }
}
