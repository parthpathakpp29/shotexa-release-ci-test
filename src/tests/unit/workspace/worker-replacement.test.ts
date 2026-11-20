import { describe, expect, it, vi } from "vitest";
import { createWorkerClient } from "@/workers/broker/worker-client";
import { WorkerBroker } from "@/core/runtime/worker-broker";
import { createWorkspaceRuntime } from "@/core/runtime/runtime";
import { readFileSync } from "node:fs";

class FakeWorker extends EventTarget {
  posted: { jobId: string }[] = [];
  postMessage(message: { jobId: string }) { this.posted.push(message); }
  terminate = vi.fn();
  success(jobId: string, output: unknown) { this.dispatchEvent(Object.assign(new Event("message"), { data: { type: "SUCCESS", jobId, output } })); }
}

describe("worker replacement ownership", () => {
  const caps = { offscreenCanvas: true, compressionStream: true, createImageBitmapResize: true };
  const file = () => new File([readFileSync("src/tests/fixtures/stitch/chat-light/a.png")], "queued.png", { type: "image/png" });
  function workspace() {
    const factory = vi.fn(() => new FakeWorker() as unknown as Worker);
    const broker = new WorkerBroker({ image: factory, vision: factory, document: factory, background: factory, privacy: factory });
    const page = new EventTarget();
    return { runtime: createWorkspaceRuntime({ broker, caps, pageEvents: page }), page, factory };
  }
  it("queued previews cannot create a worker after beforeunload", async () => {
    const { runtime, page, factory } = workspace();
    try {
      const result = await runtime.ingest([file()], "picker", { waitForPreviews: false });
      page.dispatchEvent(new Event("beforeunload"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(result.added).toHaveLength(1); expect(factory).not.toHaveBeenCalled();
      expect(runtime.store.getState().files[result.added[0]].previewVersion).toBe(0);
    } finally { runtime.dispose(); }
  });
  it("header validation cannot publish files or start workers after beforeunload", async () => {
    const { runtime, page, factory } = workspace();
    let release!: () => void; const source = file(), slice = source.slice.bind(source); let first = true;
    Object.defineProperty(source, "slice", { value: (...args: Parameters<Blob["slice"]>) => {
      const blob = slice(...args);
      if (!first) return blob; first = false;
      return { arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { release = () => { void blob.arrayBuffer().then(resolve); }; }) };
    } });
    try {
      const accepting = runtime.ingest([source], "picker", { waitForPreviews: false });
      await vi.waitFor(() => expect(release).toBeDefined()); page.dispatchEvent(new Event("beforeunload")); release();
      const result = await accepting; expect(result.added).toEqual([]); expect(factory).not.toHaveBeenCalled();
    } finally { runtime.dispose(); }
  });

  it("suspending the page terminates pending workers and resume creates a fresh worker", async () => {
    const first = new FakeWorker(), second = new FakeWorker();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const broker = new WorkerBroker({ image: factory, vision: factory, document: factory, background: factory, privacy: factory });
    const interrupted = broker.run("image", "image.encode", {} as never); void interrupted.catch(() => undefined);
    try {
      broker.suspend(); expect(first.terminate).toHaveBeenCalledOnce();
      await expect(interrupted).rejects.toMatchObject({ code: "CANCELLED" });
      await expect(broker.run("image", "image.encode", {} as never)).rejects.toMatchObject({ code: "CANCELLED" });
      expect(factory).toHaveBeenCalledOnce();
      broker.resume(); const restored = broker.run("image", "image.encode", {} as never);
      second.success(second.posted[0].jobId, "restored"); await expect(restored).resolves.toBe("restored");
      expect(factory).toHaveBeenCalledTimes(2);
    } finally { broker.dispose(); }
  });

  it.each(["terminate", "error"])("a late error after %s cannot terminate or reject its replacement", async (retire) => {
    const first = new FakeWorker(), second = new FakeWorker();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const client = createWorkerClient(factory);
    const old = client.run("image.encode", {} as never); const oldRejected = old.catch((error: unknown) => error);
    if (retire === "terminate") client.terminate();
    else first.dispatchEvent(new Event("error", { cancelable: true }));
    await oldRejected;
    const replacement = client.run("image.encode", {} as never); void replacement.catch(() => undefined);
    try {
      const late = new Event("error", { cancelable: true }); first.dispatchEvent(late);
      expect(late.defaultPrevented).toBe(true);
      expect(second.terminate).not.toHaveBeenCalled();
      second.success(second.posted[0].jobId, { bytes: "current result" });
      await expect(replacement).resolves.toEqual({ bytes: "current result" });
    } finally { client.terminate(); }
  });

  it("releases a retired worker's late preview bitmap without touching current work", async () => {
    const first = new FakeWorker(), second = new FakeWorker();
    const client = createWorkerClient(vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second));
    const old = client.run("image.preview", {} as never); void old.catch(() => undefined); client.terminate();
    const current = client.run("image.encode", {} as never); void current.catch(() => undefined);
    try {
      const bitmap = { close: vi.fn() }; first.success(first.posted[0].jobId, { bitmap });
      expect(bitmap.close).toHaveBeenCalledOnce(); expect(second.terminate).not.toHaveBeenCalled();
      second.success(second.posted[0].jobId, "current"); await expect(current).resolves.toBe("current");
    } finally { client.terminate(); }
  });
});
