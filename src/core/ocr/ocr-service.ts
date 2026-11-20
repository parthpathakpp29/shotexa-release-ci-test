/**
 * Browser OCR service — the only OCR API UI code uses (architecture §26, §32).
 *
 *   Blob ─► validate ─► [image worker: decode + OCR-only preprocessing + strips]
 *        ─► OcrEngine (Tesseract.js in its own dedicated worker, reused) ─► OcrResult
 *
 * Nothing leaves the device: models/cores are self-hosted static assets; images are
 * passed to same-origin workers only.
 */
import { DEFAULT_OCR_CONFIG, type OcrRuntimeConfig } from "@/config/ocr";
import { softBudgetFor } from "@/config/limits";
import vendorAssets from "@/config/vendor-assets.json";
import { readImageSize } from "@/core/image/image-size";
import { sniffImageType } from "@/core/image/validate";
import { createWorkerClient, WorkerJobError } from "@/workers/broker/worker-client";
import { OcrError, toOcrError } from "./errors";
import { buildResult } from "./normalize";
import { prepareForOcr, type PreparedImage } from "./prepare-image";
import type { PreprocessStep } from "./preprocess";
import { mergeStripResults, planOcrStrips } from "./strips";
import { TesseractEngine, type CreateWorker } from "./tesseract-engine";
import type { OcrLanguage, OcrResult, PageSegmentation, ReadingOrder } from "./types";

export interface ExtractOptions {
  languages?: OcrLanguage[];
  preprocessing?: "auto" | "none" | PreprocessStep[];
  readingOrder?: ReadingOrder;
  segmentation?: PageSegmentation;
  strips?: "auto" | "off" | "force";
  preserveIndentation?: boolean;
  signal?: AbortSignal;
  onProgress?: (fraction: number, stage: string) => void;
}

export interface ExtractResult extends OcrResult {
  timings: { validateMs: number; prepareMs: number; initMs: number; recogniseMs: number; totalMs: number };
  parts: number;
  /** Reasons the requested pipeline was reduced (e.g. no OffscreenCanvas). */
  fallbacks: string[];
}

export interface TesseractAssets {
  version: string;
  workerPath: string;
  corePath: string;
  langPath: string;
}

export function createOcrService(opts: { config?: OcrRuntimeConfig; assets?: TesseractAssets } = {}) {
  const config = opts.config ?? DEFAULT_OCR_CONFIG;
  const assets = opts.assets ?? vendorAssets.tesseract;
  const imageWorker = createWorkerClient(() => new Worker(new URL("../../workers/image.worker.ts", import.meta.url), { type: "module", name: "shotexa-image" }));
  let engine: TesseractEngine | null = null;
  let engineLoading: Promise<TesseractEngine> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let current: AbortController | null = null;
  let disposed = false;
  let revision = 0;
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const budgetBytes = softBudgetFor({ deviceMemoryGiB: (nav as Navigator & { deviceMemory?: number } | undefined)?.deviceMemory, isIOS: /iPad|iPhone|iPod/.test(nav?.userAgent ?? "") || nav?.platform === "MacIntel" && (nav?.maxTouchPoints ?? 0) > 1 });

  const getEngine = async () => {
    if (engine) return engine;
    if (disposed) throw new OcrError("OCR_CANCELLED");
    if (!engineLoading) engineLoading = loadEngine().finally(() => { engineLoading = null; });
    return engineLoading;
  };

  const loadEngine = async () => {
    // Separate chunk: Tesseract.js API code loads only on OCR intent.
    const { createWorker } = (await import("tesseract.js")) as unknown as { createWorker: CreateWorker };
    if (disposed) throw new OcrError("OCR_CANCELLED");
    engine = new TesseractEngine({
      createWorker,
      workerPath: assets.workerPath,
      corePath: assets.corePath,
      langPath: assets.langPath,
      cacheMethod: "write",
      version: assets.version,
      initTimeoutMs: config.initTimeoutMs,
      preflight,
    });
    return engine;
  };

  /** HEAD-check self-hosted assets once per session so a 404 fails fast with a controlled code. */
  const checked = new Set<string>();
  const preflight = async (languages: string[], signal?: AbortSignal) => {
    const head = async (url: string, code: "OCR_ENGINE_LOAD_FAILED" | "OCR_MODEL_LOAD_FAILED") => {
      if (checked.has(url)) return;
      const ok = await fetch(url, { method: "HEAD", signal }).then((r) => r.ok, () => false);
      if (signal?.aborted) throw new OcrError("OCR_CANCELLED");
      if (!ok) throw new OcrError(code, url);
      checked.add(url);
    };
    await head(assets.workerPath, "OCR_ENGINE_LOAD_FAILED");
    await head(`${assets.corePath}/tesseract-core-lstm.wasm.js`, "OCR_ENGINE_LOAD_FAILED");
    for (const l of languages) await head(`${assets.langPath}/${l}.traineddata.gz`, "OCR_MODEL_LOAD_FAILED");
  };

  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimer = null; if (!current) void engine?.terminate(); }, config.idleTerminateMs);
  };

  async function prepare(blob: Blob, width: number, height: number, o: ExtractOptions, fallbacks: string[], signal: AbortSignal): Promise<PreparedImage> {
    const wantStrips = o.strips === "force" || ((o.strips ?? "auto") === "auto" && height > config.stripThresholdPx);
    const steps = o.preprocessing ?? "auto";
    const trivial = { parts: [{ image: blob, scale: 1, y: 0, height }], steps: [] as PreprocessStep[], stats: null as never, width, height, decodeMs: 0, prepMs: 0, encodeMs: 0 };
    if (width * height * 4 > budgetBytes) throw new OcrError("OCR_OUT_OF_MEMORY");
    if (steps === "none" && !wantStrips) return trivial;
    const stripPolicy = { mode: o.strips ?? "auto", threshold: config.stripThresholdPx, height: config.stripHeightPx, overlap: config.stripOverlapPx };
    try {
      if (typeof OffscreenCanvas === "undefined") {
        fallbacks.push("NO_OFFSCREEN_CANVAS", "MAIN_THREAD_CANVAS");
        if (typeof document === "undefined") throw new OcrError("OCR_DECODE_FAILED");
        return await prepareForOcr(blob, steps === "none" ? [] : steps, undefined, signal, {
          budgetBytes, stripPolicy,
          makeCanvas: (width, height) => Object.assign(document.createElement("canvas"), { width, height }),
          analyse: (pixels) => imageWorker.run("ocr.stats", pixels, { signal }),
          process: (pixels, steps) => imageWorker.run("ocr.preprocess", { pixels, steps }, { signal }),
          afterStep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
        });
      }
      return await imageWorker.run("ocr.prepare", { image: blob, steps: steps === "none" ? [] : steps, budgetBytes, stripPolicy }, { signal });
    } catch (e) {
      const code = (e as WorkerJobError).code;
      if (code === "CANCELLED") throw new OcrError("OCR_CANCELLED");
      if (code === "OCR_DECODE_FAILED") throw new OcrError("OCR_DECODE_FAILED");
      if (code === "OCR_OUT_OF_MEMORY" || code === "MEMORY_PRESSURE") throw new OcrError("OCR_OUT_OF_MEMORY");
      if (e instanceof OcrError) throw e;
      throw toOcrError(e, "recognise");
    }
  }

  return {
    /** Pre-load engine + models (e.g. when the OCR tool opens), without recognising. */
    async warmup(languages: OcrLanguage[] = ["eng"]) {
      const generation = revision;
      const t = performance.now();
      const eng = await getEngine();
      if (disposed || generation !== revision) throw new OcrError("OCR_CANCELLED");
      await eng.initialise({ languages });
      if (disposed || generation !== revision) throw new OcrError("OCR_CANCELLED");
      scheduleIdle();
      return performance.now() - t;
    },

    async extract(blob: Blob, o: ExtractOptions = {}): Promise<ExtractResult> {
      const t0 = performance.now();
      if (disposed || o.signal?.aborted) throw new OcrError("OCR_CANCELLED");
      revision++;
      current?.abort();
      const ac = new AbortController();
      current = ac;
      const parentAbort = () => ac.abort();
      o.signal?.addEventListener("abort", parentAbort, { once: true });
      const stop = () => { if (current === ac) { imageWorker.terminate(); void engine?.cancel(); } };
      ac.signal.addEventListener("abort", stop, { once: true });
      const check = () => { if (disposed || current !== ac || ac.signal.aborted) throw new OcrError("OCR_CANCELLED"); };
      let progress = 0;
      const notify = (value: number, stage: string) => { if (current === ac && !ac.signal.aborted) { progress = Math.max(progress, Math.min(1, Math.max(0, value))); o.onProgress?.(progress, stage); } };
      if (idleTimer) clearTimeout(idleTimer);
      const fallbacks: string[] = [];
      try {
      const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
      const size = sniffImageType(head) ? await readImageSize(blob) : null;
      if (!size) throw new OcrError("OCR_DECODE_FAILED", "unsupported or corrupt image header");
      check();
      if (size.width * size.height * 4 > budgetBytes) throw new OcrError("OCR_OUT_OF_MEMORY");
      const validateMs = performance.now() - t0;

      const t1 = performance.now();
      notify(0.02, "preparing");
      if (size.width * size.height >= config.recycleAfterPixels) await engine?.terminate();
      check();
      const prepared = await prepare(blob, size.width, size.height, o, fallbacks, ac.signal);
      const prepareMs = performance.now() - t1;
      check();
      const original = { width: prepared.width, height: prepared.height };

      const t2 = performance.now();
      const eng = await getEngine();
      check();
      await eng.initialise({ languages: o.languages ?? ["eng"], onProgress: (p, stage) => notify(0.03 + 0.12 * p, stage) }).catch((e) => {
        throw e instanceof OcrError ? e : new OcrError("OCR_ENGINE_LOAD_FAILED");
      });
      const initMs = performance.now() - t2;
      check();
      notify(0.15, "reading text");

      const t3 = performance.now();
      const n = prepared.parts.length;
      const results = [];
      for (const [i, part] of prepared.parts.entries()) {
        check();
        const r = await eng.recognise(
          { image: part.image, original, transform: { scale: part.scale, offsetX: 0, offsetY: part.y }, preprocessing: prepared.steps },
          {
            languages: o.languages,
            segmentation: o.segmentation,
            readingOrder: o.readingOrder ?? "auto",
            preserveIndentation: o.preserveIndentation,
            signal: ac.signal,
            onProgress: (p, stage) => notify(0.15 + (0.84 * (i + (stage === "recognizing text" ? p : 0))) / n, n > 1 ? `${stage} · section ${i + 1} of ${n}` : stage),
          },
        );
        results.push(r);
        // Encoded copies are no longer needed once this strip has been recognized.
        part.image = new Blob();
      }
      const recogniseMs = performance.now() - t3;

      let result: OcrResult = results[0];
      if (n > 1) {
        const strips = planOcrStrips(original.height, config.stripHeightPx, config.stripOverlapPx);
        const merged = mergeStripResults(results.map((r, i) => ({ strip: strips[i], result: r })), original);
        result = buildResult({
          blocks: merged.blocks,
          language: results[0].language,
          durationMs: merged.durationMs,
          image: original,
          preprocessing: prepared.steps,
          engine: results[0].engine,
          options: { readingOrder: o.readingOrder ?? "auto", preserveIndentation: o.preserveIndentation },
        });
      }
      check();
      // Large jobs grow the engine's WASM heap permanently: recycle the worker afterwards.
      const recognisedPixels = prepared.parts.reduce((sum, p) => sum + original.width * p.scale * p.height * p.scale, 0);
      if (recognisedPixels >= config.recycleAfterPixels) await eng.terminate();
      check();
      notify(1, "done");
      return { ...result, timings: { validateMs, prepareMs, initMs, recogniseMs, totalMs: performance.now() - t0 }, parts: n, fallbacks };
      } finally {
        o.signal?.removeEventListener("abort", parentAbort);
        ac.signal.removeEventListener("abort", stop);
        if (current === ac) { current = null; if (engine?.isLoaded) scheduleIdle(); }
      }
    },

    /** Cancel the running job (terminates the OCR worker; next job re-initialises from cache). */
    async cancel() {
      revision++;
      current?.abort();
      current = null;
      imageWorker.terminate();
      await engine?.cancel();
    },

    async dispose() {
      disposed = true;
      revision++;
      if (idleTimer) clearTimeout(idleTimer);
      current?.abort();
      await engine?.terminate();
      engine = null;
      imageWorker.terminate();
    },

    get engineLoaded() {
      return engine?.isLoaded ?? false;
    },
  };
}

export type OcrService = ReturnType<typeof createOcrService>;
