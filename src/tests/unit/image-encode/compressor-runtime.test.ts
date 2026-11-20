import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceRuntime } from "@/core/runtime/runtime";
import type { WorkerBroker } from "@/core/runtime/worker-broker";
import { FORMAT_MIME, type OutputFormat } from "@/core/image-encode/formats";
import { encodeSize } from "@/core/image-encode/geometry";

type Input = { image: Blob; source: { width: number; height: number }; format: OutputFormat; quality: number; resizePercent?: number; existing?: unknown[] };
const encoded = (input: Input) => ({ blob: new Blob([new Uint8Array(100)], { type: FORMAT_MIME[input.format] }), ...encodeSize(input.source, input.resizePercent), format: input.format, quality: input.quality, strategy: "single-canvas", ms: 1 });
async function setup(encode: (input: Input) => unknown = encoded) {
  const calls: { op: string; input: Input }[] = [];
  const broker = { started: new Set(), release: vi.fn(), dispose: vi.fn(), run: vi.fn(async (_kind: string, op: string, input: Input) => {
    if (op === "image.preview") return { bitmap: { width: 100, height: 100, close: vi.fn() } };
    calls.push({ op, input });
    if (op === "image.encode") return encode(input);
    if (op === "image.compareFormats") return { candidates: (["png", "jpeg", "webp"] as const).map((format) => ({ ...encoded({ ...input, format }), bytes: 100 })), ms: 1 };
    throw new Error("Unsupported operation");
  }) } as unknown as WorkerBroker;
  const runtime = createWorkspaceRuntime({ broker, caps: { offscreenCanvas: true, compressionStream: true, createImageBitmapResize: true } });
  const { added: [id] } = await runtime.ingest([new File([readFileSync(join(process.cwd(), "src/tests/fixtures/stitch/chat-light/a.png"))], "source.png", { type: "image/png" })], "picker");
  return { runtime, id, calls };
}

describe("Compressor runtime coordination", () => {
  it("keeps workflow compression at the input dimensions after a user resized in Compressor", async () => {
    const { runtime, id, calls } = await setup();
    try {
      runtime.store.getState().setEncodeSettings("compress", { resizePercent: 50 });
      const { createWorkflowAdapters } = await import("@/core/workflows/adapters");
      const result = await createWorkflowAdapters(runtime).compress!.execute({
        id: "compress", name: "Compress", description: "Compress without a resize step", action: "compress", config: { format: "same", quality: 0.8 },
      }, { runId: "compatibility", originalAssetIds: [id], assetIds: [id], outputIds: [], data: {}, checks: [], signal: new AbortController().signal, reportProgress: vi.fn() });
      const output = runtime.store.getState().files[result.assetIds![0]];
      expect([output.width, output.height]).toEqual([1170, 2532]);
      expect(calls.find((call) => call.op === "image.encode")?.input.resizePercent).toBe(100);
    } finally { runtime.dispose(); }
  });
  it("preserves old defaults and only forwards resizing after an explicit setting", async () => {
    const { runtime, id, calls } = await setup();
    try {
      const original = await runtime.encodeAsset("compress", id);
      expect(original).toMatchObject({ width: 1170, height: 2532, format: "png", resizePercent: 100 });
      runtime.store.getState().setEncodeSettings("compress", { resizePercent: 50 });
      const smaller = await runtime.encodeAsset("compress", id, { measureAlternative: false });
      expect(smaller).toMatchObject({ width: 585, height: 1266 });
      expect(calls.at(-1)?.input.resizePercent).toBe(50);
      expect(runtime.store.getState().files[id]).toMatchObject({ width: 1170, height: 2532 });
    } finally { runtime.dispose(); }
  });
  it("reuses a completed measurement for repeat checks", async () => {
    const { runtime, id, calls } = await setup();
    try {
      const a = await runtime.encodeAsset("compress", id, { measureAlternative: false });
      const b = await runtime.encodeAsset("compress", id, { measureAlternative: false });
      expect(a.blob).toBe(b.blob);
      expect(calls.filter((call) => call.op === "image.encode")).toHaveLength(1);
    } finally { runtime.dispose(); }
  });
  it("measures Compressor settings and reuses a chosen candidate", async () => {
    const { runtime, id, calls } = await setup();
    try {
      runtime.store.getState().setEncodeSettings("compress", { quality: 0.65, resizePercent: 50 });
      const formats = await runtime.compareEncodeFormats(id, "compress");
      expect(calls[0].input).toMatchObject({ quality: 0.65, resizePercent: 50 });
      expect(formats.candidates.every((candidate) => candidate.tool === "compress")).toBe(true);
      runtime.store.getState().setEncodeSettings("compress", { format: "webp" });
      const chosen = await runtime.encodeAsset("compress", id, { measureAlternative: false });
      expect(chosen.blob).toBe(formats.candidates.find((candidate) => candidate.format === "webp")!.blob);
      expect(calls).toHaveLength(1);
    } finally { runtime.dispose(); }
  });
  it("rejects an old completion after settings change and serializes the next encode", async () => {
    let finish!: (value: unknown) => void;
    let count = 0;
    const { runtime, id, calls } = await setup((input) => ++count === 1 ? new Promise((resolve) => { finish = resolve; }) : encoded(input));
    try {
      runtime.store.getState().setEncodeSettings("compress", { format: "webp" });
      const old = runtime.encodeAsset("compress", id, { measureAlternative: false });
      const rejected = expect(old).rejects.toMatchObject({ code: "ENCODE_CANCELLED" });
      await vi.waitFor(() => expect(finish).toBeDefined());
      runtime.store.getState().setEncodeSettings("compress", { quality: 0.6 });
      const latest = runtime.encodeAsset("compress", id, { measureAlternative: false });
      finish(encoded(calls[0].input));
      await rejected;
      expect((await latest).quality).toBe(0.6);
      expect(runtime.store.getState().order).toEqual([id]);
    } finally { runtime.dispose(); }
  });
  it("rejects a worker MIME mismatch without caching output", async () => {
    const { runtime, id } = await setup((input) => ({ ...encoded(input), blob: new Blob(["wrong"], { type: "image/jpeg" }) }));
    try { await expect(runtime.encodeAsset("compress", id)).rejects.toMatchObject({ code: "ENCODE_VERIFY_FAILED" }); }
    finally { runtime.dispose(); }
  });
});
