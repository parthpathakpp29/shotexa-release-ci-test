import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceRuntime } from "@/core/runtime/runtime";
import type { WorkerBroker } from "@/core/runtime/worker-broker";
import type { OcrService } from "@/core/ocr/ocr-service";
import type { SafeShareExportResult, SafeShareVerification } from "@/core/redaction/types";
import { FIXTURE_DIR } from "../../helpers/stitch-fixtures";

const CAPS = { offscreenCanvas: true, compressionStream: true, createImageBitmapResize: true };
const VERIFIED: SafeShareVerification = {
  redactionsFlattened: true,
  privacyMetadataRemoved: true,
  outputVerified: true,
  dimensionsMatch: true,
  formatMatch: true,
};

async function setup(verification: SafeShareVerification | null = { ...VERIFIED }, type = "image/png", extract = vi.fn()) {
  const blob = new Blob([new Uint8Array(96)], { type });
  const broker = {
    started: new Set(),
    run: vi.fn(async (_kind: string, op: string) => {
      if (op === "image.preview") return { bitmap: { width: 100, height: 100, close: vi.fn() } };
      if (op === "redaction.export") return {
        blob, width: 1170, height: 2532, verification,
        removedCategories: [], ms: { render: 1, clean: 1, verifyDecode: 1, total: 3 },
      } as SafeShareExportResult;
      throw Object.assign(new Error("unsupported"), { code: "UNSUPPORTED" });
    }),
    release: vi.fn(),
    dispose: vi.fn(),
  } as unknown as WorkerBroker;
  const ocrService = { extract, cancel: vi.fn(), dispose: vi.fn() } as unknown as OcrService;
  const runtime = createWorkspaceRuntime({ broker, caps: CAPS, createOcrService: async () => ocrService });
  const file = new File([readFileSync(join(FIXTURE_DIR, "chat-light/a.png"))], "source.png", { type: "image/png" });
  const { added: [sourceId] } = await runtime.ingest([file], "picker");
  runtime.store.getState().addRedaction(sourceId, { x: 10, y: 20, width: 100, height: 80 }, "blackout");
  return { runtime, sourceId, blob };
}

describe("redaction verification boundary", () => {
  for (const method of ["prepareSafeShare", "exportSafeShare"] as const) {
    it.each(Object.keys(VERIFIED) as (keyof SafeShareVerification)[])(`${method} rejects a failed %s check without registering output`, async (flag) => {
      const { runtime, sourceId } = await setup({ ...VERIFIED, [flag]: false });
      try {
        await expect(runtime[method](sourceId)).rejects.toMatchObject({ code: "REDACTION_VERIFY_FAILED" });
        expect(runtime.store.getState().order).toEqual([sourceId]);
        expect(runtime.registry.stats().blobs).toBe(1);
        expect(Object.values(runtime.store.getState().jobs).find((job) => job.kind === "redaction-export"))
          .toMatchObject({ status: "failed", error: "REDACTION_VERIFY_FAILED" });
      } finally { runtime.dispose(); }
    });
  }

  it("rejects a MIME mismatch even when the worker reports all verification flags true", async () => {
    const { runtime, sourceId } = await setup({ ...VERIFIED }, "image/jpeg");
    try {
      await expect(runtime.prepareSafeShare(sourceId)).rejects.toMatchObject({ code: "REDACTION_VERIFY_FAILED" });
      expect(runtime.registry.stats().blobs).toBe(1);
    } finally { runtime.dispose(); }
  });

  it("rejects a result with no verification record", async () => {
    const { runtime, sourceId } = await setup(null);
    try {
      await expect(runtime.prepareSafeShare(sourceId)).rejects.toMatchObject({ code: "REDACTION_VERIFY_FAILED" });
      expect(runtime.registry.stats().blobs).toBe(1);
    } finally { runtime.dispose(); }
  });

  it("keeps a verified prepared copy private until explicit publication", async () => {
    const { runtime, sourceId, blob } = await setup();
    try {
      const prepared = await runtime.prepareSafeShare(sourceId);
      expect(runtime.store.getState().order).toEqual([sourceId]);
      expect(runtime.store.getState().files[prepared.id]).toBeUndefined();
      expect(runtime.registry.blob(prepared.id)).toBe(blob);
      expect(runtime.publishPreparedSafeShare(prepared.id)).toBe(prepared.id);
      expect(runtime.store.getState().files[prepared.id]).toMatchObject({ producedBy: "safe-share", derivedFrom: [sourceId], type: "image/png" });
      expect(runtime.store.getState().selectedId).toBe(prepared.id);
    } finally { runtime.dispose(); }
  });

  it("refuses publication if the exact verified blob has been replaced", async () => {
    const { runtime, sourceId } = await setup();
    try {
      const prepared = await runtime.prepareSafeShare(sourceId);
      runtime.registry.put(prepared.id, new Blob(["replacement"], { type: "image/png" }));
      expect(() => runtime.publishPreparedSafeShare(prepared.id)).toThrow(expect.objectContaining({ code: "REDACTION_VERIFY_FAILED" }));
      expect(runtime.store.getState().files[prepared.id]).toBeUndefined();
    } finally { runtime.dispose(); }
  });

  it("checks the unpublished output with the existing local OCR service without exposing OCR state", async () => {
    const result = { blocks: [], rawText: "", editedText: "", timings: { totalMs: 1 } };
    const extract = vi.fn().mockResolvedValue(result);
    const { runtime, sourceId, blob } = await setup({ ...VERIFIED }, "image/png", extract);
    try {
      const prepared = await runtime.prepareSafeShare(sourceId);
      expect(await runtime.extractPreparedSafeShareText(prepared.id)).toBe(result);
      expect(extract).toHaveBeenCalledWith(blob, expect.objectContaining({ preprocessing: "auto", signal: expect.any(AbortSignal) }));
      expect(runtime.store.getState().order).toEqual([sourceId]);
      expect(runtime.store.getState().ocr.byAsset[prepared.id]).toBeUndefined();
      expect(runtime.ocrResults.forAsset(prepared.id)).toBeUndefined();
      runtime.publishPreparedSafeShare(prepared.id);
    } finally { runtime.dispose(); }
  });

  it("leaves the copy unpublished when optional OCR fails", async () => {
    const extract = vi.fn().mockRejectedValue(Object.assign(new Error("OCR_TIMEOUT"), { code: "OCR_TIMEOUT" }));
    const { runtime, sourceId } = await setup({ ...VERIFIED }, "image/png", extract);
    try {
      const prepared = await runtime.prepareSafeShare(sourceId);
      await expect(runtime.extractPreparedSafeShareText(prepared.id)).rejects.toMatchObject({ code: "OCR_TIMEOUT" });
      expect(runtime.store.getState().order).toEqual([sourceId]);
      expect(runtime.store.getState().ocr.byAsset[prepared.id]).toBeUndefined();
      runtime.discardPreparedSafeShare(prepared.id);
      expect(runtime.registry.blob(prepared.id)).toBeUndefined();
      expect(() => runtime.publishPreparedSafeShare(prepared.id)).toThrow();
    } finally { runtime.dispose(); }
  });

  it("blocks publication during optional OCR and ignores a result after the copy is discarded", async () => {
    let finish!: (value: unknown) => void;
    const extract = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { runtime, sourceId } = await setup({ ...VERIFIED }, "image/png", extract);
    try {
      const prepared = await runtime.prepareSafeShare(sourceId);
      const checking = runtime.extractPreparedSafeShareText(prepared.id);
      const rejected = expect(checking).rejects.toMatchObject({ code: "OCR_CANCELLED" });
      await vi.waitFor(() => expect(extract).toHaveBeenCalled());
      expect(() => runtime.publishPreparedSafeShare(prepared.id)).toThrow(expect.objectContaining({ code: "REDACTION_VERIFY_FAILED" }));
      runtime.discardPreparedSafeShare(prepared.id);
      finish({ blocks: [], rawText: "", editedText: "", timings: { totalMs: 1 } });
      await rejected;
      expect(runtime.store.getState().order).toEqual([sourceId]);
      expect(runtime.ocrResults.forAsset(prepared.id)).toBeUndefined();
      expect(() => runtime.publishPreparedSafeShare(prepared.id)).toThrow();
    } finally { runtime.dispose(); }
  });
});
