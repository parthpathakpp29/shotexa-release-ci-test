import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceRuntime } from "@/core/runtime/runtime";
import type { WorkerBroker } from "@/core/runtime/worker-broker";

const data = readFileSync(join(process.cwd(), "src/tests/fixtures/stitch/chat-light/a.png"));
const file = (name = "a.png") => new File([data], name, { type: "image/png" });
const bitmap = () => ({ width: 1024, height: 2216, close: vi.fn() }) as unknown as ImageBitmap;
function setup(work: () => Promise<{ bitmap: ImageBitmap; width: number; height: number }> = async () => ({ bitmap: bitmap(), width: 1170, height: 2532 })) {
  const run = vi.fn(async (_family: string, op: string) => { if (op === "image.preview") return work(); throw new Error("Unexpected operation"); });
  const broker = { run, started: new Set(), release: vi.fn(), dispose: vi.fn() } as unknown as WorkerBroker;
  return { runtime: createWorkspaceRuntime({ broker, pageEvents: null }), run };
}
const until = async (check: () => void) => vi.waitFor(check);

describe("shared file acceptance and preview ownership", () => {
  it("counts retained previews against the next decode budget and recovers after removal", async () => {
    const { runtime, run } = setup();
    try {
      const { added } = await runtime.ingest(Array.from({ length: 29 }, (_, i) => file(`${i}.png`)), "picker");
      expect(added).toHaveLength(29);
      expect(runtime.store.getState().jobs[`preview:${added[28]}`]).toMatchObject({ status: "failed", error: "PREVIEW_MEMORY_PRESSURE" });
      expect(run).toHaveBeenCalledTimes(28);
      expect(runtime.registry.previewMemory().bytes).toBeLessThan(256 * 1048576);
      runtime.removeFile(added[0]); await runtime.retryPreviews();
      expect(runtime.store.getState().jobs[`preview:${added[28]}`].status).toBe("done");
      expect(runtime.store.getState().files[added[28]]).toMatchObject({ width: 1170, height: 2532 });
    } finally { runtime.dispose(); }
  });
  it("uses the existing low-memory device budget before automatic decoding", async () => {
    vi.stubGlobal("navigator", { deviceMemory: 2, userAgent: "test", platform: "test" });
    const bytes = new Uint8Array(33), view = new DataView(bytes.buffer);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(16, 6000); view.setUint32(20, 6000);
    const { runtime, run } = setup();
    try {
      const { added: [id] } = await runtime.ingest([new File([bytes], "large.png", { type: "image/png" })], "picker");
      expect(runtime.store.getState().jobs[`preview:${id}`]).toMatchObject({ error: "PREVIEW_TOO_LARGE" });
      expect(runtime.registry.has(id)).toBe(true); expect(run).not.toHaveBeenCalled();
    } finally { runtime.dispose(); vi.unstubAllGlobals(); }
  });
  it("a cleared workspace cannot receive a stale overlap hint or completion job", async () => {
    const { runtime } = setup();
    const unsubscribe = runtime.store.subscribe((state) => { if (state.jobs.overlap?.status === "running") runtime.clear(); });
    try {
      await runtime.ingest([file(), file("b.png")], "picker");
      expect(runtime.store.getState().order).toEqual([]);
      expect(runtime.store.getState().overlapHint.status).toBe("idle");
      expect(runtime.store.getState().jobs).toEqual({});
    } finally { unsubscribe(); runtime.dispose(); }
  });
  it("acknowledges accepted files before a held preview, while legacy calls still await readiness", async () => {
    let finish!: (value: { bitmap: ImageBitmap; width: number; height: number }) => void;
    const { runtime, run } = setup(() => new Promise((resolve) => { finish = resolve; }));
    try {
      const result = await runtime.ingest([file()], "picker", { waitForPreviews: false });
      expect(runtime.store.getState().order).toEqual(result.added);
      await until(() => expect(run).toHaveBeenCalledTimes(1));
      expect(runtime.store.getState().files[result.added[0]].previewVersion).toBe(0);
      finish({ bitmap: bitmap(), width: 1170, height: 2532 });
      await until(() => expect(runtime.store.getState().files[result.added[0]].previewVersion).toBe(1));
      await runtime.retryPreviews();
      expect(run).toHaveBeenCalledTimes(1);
      let settled = false;
      const legacy = runtime.ingest([file("b.png")], "picker").then((value) => { settled = true; return value; });
      await until(() => expect(run).toHaveBeenCalledTimes(2));
      expect(settled).toBe(false);
      finish({ bitmap: bitmap(), width: 1170, height: 2532 });
      expect((await legacy).added).toHaveLength(1);
    } finally { runtime.dispose(); }
  });

  it("preserves upload request order even when an earlier file header is slow", async () => {
    const first = file("first.png"), second = file("second.png");
    const slice = first.slice.bind(first); let release!: (value: ArrayBuffer) => void, once = true;
    vi.spyOn(first, "slice").mockImplementation((start, end) => {
      if (once) { once = false; return { arrayBuffer: () => new Promise((resolve) => { release = resolve; }) } as Blob; }
      return slice(start, end);
    });
    const { runtime } = setup();
    try {
      const a = runtime.ingest([first], "drop", { waitForPreviews: false });
      await until(() => expect(release).toBeDefined());
      const b = runtime.ingest([second], "paste", { waitForPreviews: false });
      expect(runtime.store.getState().order).toEqual([]);
      release(await slice(0, 16).arrayBuffer());
      const [one, two] = await Promise.all([a, b]);
      expect(runtime.store.getState().order).toEqual([...one.added, ...two.added]);
    } finally { runtime.dispose(); }
  });

  it("clear during a file read cannot repopulate the workspace or orphan a Blob", async () => {
    const input = file(); const slice = input.slice.bind(input); let release!: (value: ArrayBuffer) => void;
    vi.spyOn(input, "slice").mockImplementationOnce(() => ({ arrayBuffer: () => new Promise((resolve) => { release = resolve; }) }) as Blob);
    const { runtime, run } = setup();
    try {
      const loading = runtime.ingest([input], "picker");
      await until(() => expect(release).toBeDefined());
      runtime.clear(); release(await slice(0, 16).arrayBuffer());
      expect((await loading).added).toEqual([]);
      expect(runtime.store.getState().order).toEqual([]);
      expect(runtime.registry.stats().blobs).toBe(0);
      expect(run).not.toHaveBeenCalled();
    } finally { runtime.dispose(); }
  });

  it("cancels a queued batch without starting its decoders and closes the late active bitmap", async () => {
    let release!: (value: { bitmap: ImageBitmap; width: number; height: number }) => void;
    const late = bitmap();
    const { runtime, run } = setup(() => new Promise((resolve) => { release = resolve; }));
    try {
      const { added } = await runtime.ingest([file(), file("b.png"), file("c.png")], "drop", { waitForPreviews: false });
      await until(() => expect(run).toHaveBeenCalledTimes(1));
      runtime.cancelPreviews(); release({ bitmap: late, width: 1170, height: 2532 });
      await until(() => expect(late.close).toHaveBeenCalledOnce());
      expect(runtime.store.getState().order).toEqual(added);
      expect(runtime.registry.stats().previews).toBe(0);
      expect(added.map((id) => runtime.store.getState().jobs[`preview:${id}`].status)).toEqual(["cancelled", "cancelled", "cancelled"]);
      expect(run).toHaveBeenCalledTimes(1);
    } finally { runtime.dispose(); }
  });

  it("deduplicates retries and cached work, then frees previews and URLs on clear", async () => {
    const image = bitmap(); const { runtime, run } = setup(async () => ({ bitmap: image, width: 1170, height: 2532 }));
    try {
      const { added: [id] } = await runtime.ingest([file()], "picker", { waitForPreviews: false });
      await Promise.all([runtime.retryPreviews(), runtime.retryPreviews()]);
      expect(run).toHaveBeenCalledTimes(1);
      runtime.registry.objectUrl(id);
      expect(runtime.registry.previewMemory().bytes).toBe(image.width * image.height * 4);
      runtime.clear();
      expect(image.close).toHaveBeenCalledOnce();
      expect(runtime.registry.previewMemory()).toEqual({ pixels: 0, bytes: 0 });
      expect(runtime.registry.stats()).toEqual({ blobs: 0, previews: 0, urls: 0, bytes: 0 });
      expect(runtime.store.getState().jobs).toEqual({});
    } finally { runtime.dispose(); }
  });

  it("a removed file cannot receive a preview or a new job from late work", async () => {
    let release!: (value: { bitmap: ImageBitmap; width: number; height: number }) => void;
    const late = bitmap(); const { runtime, run } = setup(() => new Promise((resolve) => { release = resolve; }));
    try {
      const { added: [id] } = await runtime.ingest([file()], "picker", { waitForPreviews: false });
      await until(() => expect(run).toHaveBeenCalledTimes(1));
      runtime.removeFile(id); release({ bitmap: late, width: 1170, height: 2532 });
      await until(() => expect(late.close).toHaveBeenCalledOnce());
      expect(runtime.registry.stats().previews).toBe(0);
      expect(runtime.store.getState().jobs[`preview:${id}`]).toBeUndefined();
    } finally { runtime.dispose(); }
  });
});
