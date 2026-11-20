import { describe, expect, it, vi } from "vitest";
import { TesseractEngine, type TesseractWorkerLike } from "@/core/ocr/tesseract-engine";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const worker = (): TesseractWorkerLike => ({ recognize: vi.fn(async () => ({ data: { text: "", blocks: [], confidence: 0 } })), setParameters: vi.fn(async () => {}), reinitialize: vi.fn(async () => {}), terminate: vi.fn(async () => {}) });
const input = { image: new Uint8Array([1]), original: { width: 10, height: 10 } };

describe("OCR initialization and cancellation ownership", () => {
  it("retries recognition failures on a fresh worker", async () => {
    const failed = worker(), fresh = worker();
    vi.mocked(failed.recognize).mockRejectedValueOnce(new Error("recognition failed"));
    const createWorker = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(fresh);
    const engine = new TesseractEngine({ createWorker, langPath: "/local", version: "test" });
    try {
      await expect(engine.recognise(input)).rejects.toBeDefined();
      expect(failed.terminate).toHaveBeenCalledOnce();
      await engine.recognise(input);
      expect(createWorker).toHaveBeenCalledTimes(2); expect(fresh.recognize).toHaveBeenCalledOnce();
    } finally { await engine.terminate(); }
  });
  it("direct cancellation settles a stalled recognition without a caller signal", async () => {
    const w = worker(); vi.mocked(w.recognize).mockImplementation(() => new Promise(() => {}));
    const engine = new TesseractEngine({ createWorker: async () => w, langPath: "/local", version: "test" });
    const job = engine.recognise(input); void job.catch(() => {});
    await vi.waitFor(() => expect(w.recognize).toHaveBeenCalledOnce());
    await engine.cancel(); await expect(job).rejects.toMatchObject({ code: "OCR_CANCELLED" });
    expect(engine.isLoaded).toBe(false);
  });
  it("coalesces concurrent initialization of the same language", async () => {
    const creating = deferred<TesseractWorkerLike>(), w = worker(), createWorker = vi.fn(() => creating.promise);
    const engine = new TesseractEngine({ createWorker, langPath: "/local", version: "test" });
    try {
      const a = engine.initialise(), b = engine.initialise();
      creating.resolve(w); await Promise.all([a, b]);
      expect(createWorker).toHaveBeenCalledTimes(1); expect(engine.isLoaded).toBe(true);
    } finally { await engine.terminate(); }
  });

  it("cancelled initialization cannot resurrect a late worker", async () => {
    const creating = deferred<TesseractWorkerLike>(), w = worker(), createWorker = vi.fn(() => creating.promise);
    const engine = new TesseractEngine({ createWorker, langPath: "/local", version: "test" });
    const initializing = engine.initialise(); void initializing.catch(() => {});
    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledOnce());
    await engine.cancel(); creating.resolve(w);
    try {
      await expect(initializing).rejects.toMatchObject({ code: "OCR_CANCELLED" });
      await vi.waitFor(() => expect(w.terminate).toHaveBeenCalledOnce()); expect(engine.isLoaded).toBe(false);
    } finally { await engine.terminate(); }
  });

  it("an abort while loading never starts recognition on the late worker", async () => {
    const creating = deferred<TesseractWorkerLike>(), w = worker(), createWorker = vi.fn(() => creating.promise), abort = new AbortController();
    const engine = new TesseractEngine({ createWorker, langPath: "/local", version: "test" });
    const job = engine.recognise(input, { signal: abort.signal }); void job.catch(() => {});
    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledOnce()); abort.abort(); creating.resolve(w);
    try {
      await expect(job).rejects.toMatchObject({ code: "OCR_CANCELLED" }); expect(w.recognize).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(w.terminate).toHaveBeenCalledOnce());
    } finally { await engine.terminate(); }
  });

  it("cancels a stalled parameter update without waiting for recognition to start", async () => {
    const parameters = deferred<void>(), w = worker(), abort = new AbortController();
    vi.mocked(w.setParameters).mockImplementation(() => parameters.promise);
    const engine = new TesseractEngine({ createWorker: async () => w, langPath: "/local", version: "test" });
    const job = engine.recognise(input, { signal: abort.signal }); void job.catch(() => {});
    await vi.waitFor(() => expect(w.setParameters).toHaveBeenCalled()); abort.abort();
    let cancelled = false; void job.catch(() => { cancelled = true; });
    try { await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 100 }); expect(w.recognize).not.toHaveBeenCalled(); }
    finally { parameters.resolve(); await job.catch(() => {}); await engine.terminate(); }
  });
});
