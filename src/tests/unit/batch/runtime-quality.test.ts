import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceRuntime } from "@/core/runtime/runtime";
import type { WorkerBroker } from "@/core/runtime/worker-broker";
import { MAX_BATCH_FILES, MAX_BATCH_INPUT_BYTES } from "@/core/batch/types";

async function setup(encode: (call: number) => Promise<unknown>) {
  let count = 0;
  const broker = { started: new Set(), release: vi.fn(), dispose: vi.fn(), run: vi.fn(async (_kind: string, op: string) => {
    if (op === "image.preview") return { bitmap: { width: 10, height: 10, close: vi.fn() }, width: 1170, height: 2532 };
    if (op === "image.encode") return encode(++count);
    throw new Error(op);
  }) } as unknown as WorkerBroker;
  const runtime = createWorkspaceRuntime({ broker, caps: { offscreenCanvas: true, compressionStream: true, createImageBitmapResize: true }, pageEvents: null });
  const bytes = readFileSync("src/tests/fixtures/stitch/chat-light/a.png");
  const { added } = await runtime.ingest(["one.png", "two.png", "three.png"].map((name) => new File([bytes], name, { type: "image/png" })), "picker");
  runtime.store.getState().setBatchSelection(added);
  return { runtime, added, calls: () => count };
}
const encoded = () => ({ blob: new Blob(["pixels"], { type: "image/png" }), width: 1170, height: 2532, format: "png", strategy: "single-canvas", ms: 1 });
describe("Batch recovery and boundaries", () => {
  it("retry names the actual failed file, retains successes and preserves result order", async () => {
    let finish!: (value: unknown) => void;
    const { runtime, added, calls } = await setup(async (n) => {
      if (n === 2) throw Object.assign(new Error("Invalid"), { code: "DECODE_FAILED" });
      if (n === 4) return new Promise((resolve) => { finish = resolve; });
      return encoded();
    });
    try {
      expect(await runtime.runBatch()).toEqual({ completed: 2, failed: 1, cancelled: 0 });
      const first = runtime.batchResults.list()[0];
      const retry = runtime.retryBatchFailed(); await vi.waitFor(() => expect(finish).toBeDefined());
      expect(runtime.store.getState().batch.currentIndex).toBe(1);
      expect(runtime.store.getState().batch.items[added[1]].status).toBe("processing");
      finish(encoded()); await retry; expect(calls()).toBe(4); expect(runtime.batchResults.get(first.id)).toBe(first);
      const zip = await runtime.createBatchZip(); expect(zip.names).toEqual(["compressed-one.png", "compressed-two.png", "compressed-three.png"]);
    } finally { runtime.dispose(); }
    expect(runtime.batchResults.stats()).toEqual({ results: 0, urls: 0, bytes: 0 });
  });
  it("cancellation before the first success can resume every unprocessed input", async () => {
    let finish!: (value: unknown) => void;
    const { runtime, added, calls } = await setup(async (n) => n === 1 ? new Promise((resolve) => { finish = resolve; }) : encoded());
    try {
      const pending = runtime.runBatch(); await vi.waitFor(() => expect(finish).toBeDefined()); runtime.cancelBatch(); finish(encoded());
      expect(await pending).toEqual({ completed: 0, failed: 0, cancelled: 3 }); expect(runtime.batchResults.stats().results).toBe(0);
      expect(added.every((id) => runtime.store.getState().batch.items[id].status === "cancelled")).toBe(true);
      expect(await runtime.retryBatchFailed()).toEqual({ completed: 3, failed: 0, cancelled: 0 }); expect(calls()).toBe(4);
    } finally { runtime.dispose(); }
  });
  it("refuses configured input-byte and count boundaries before clearing successful outputs", async () => {
    const { runtime, added } = await setup(async () => encoded());
    try {
      await runtime.runBatch(); const results = runtime.batchResults.list();
      const original = runtime.store.getState().files[added[0]];
      runtime.store.setState((s) => ({ files: { ...s.files, [original.id]: { ...original, bytes: MAX_BATCH_INPUT_BYTES + 1 } } }));
      await expect(runtime.runBatch()).rejects.toMatchObject({ code: "BATCH_INPUT_TOO_LARGE" });
      expect(runtime.batchResults.list()).toEqual(results); expect(MAX_BATCH_FILES).toBe(50);
      const extras = Array.from({ length: MAX_BATCH_FILES + 1 }, (_, i) => ({ ...original, id: `extra-${i}`, bytes: 1 }));
      runtime.store.getState().addFiles(extras);
      await expect(runtime.runBatch(extras.map((file) => file.id))).rejects.toMatchObject({ code: "BATCH_TOO_MANY_FILES" }); expect(runtime.batchResults.list()).toEqual(results);
    } finally { runtime.dispose(); }
  });
});
