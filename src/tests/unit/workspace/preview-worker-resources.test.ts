import { describe, expect, it, vi } from "vitest";
import { createWorkerClient } from "@/workers/broker/worker-client";
import { PROTOCOL_VERSION, serveWorker, type WorkerRequest, type WorkerResponse } from "@/workers/protocol";

class FakeWorker extends EventTarget {
  postMessage = vi.fn();
  terminate = vi.fn();
  respond(data: WorkerResponse) { this.dispatchEvent(new MessageEvent("message", { data })); }
}
const input = () => ({ image: new Blob(["image"]), maxWidth: 1024, maxPixels: 4000000 });
const bitmap = () => ({ width: 10, height: 20, close: vi.fn() }) as unknown as ImageBitmap;
const output = (image = bitmap()) => ({ bitmap: image, width: 10, height: 20 });

describe("preview worker resource ownership", () => {
  it("removes completed-job abort listeners and never sends cancellation after completion", async () => {
    const worker = new FakeWorker(), client = createWorkerClient(() => worker as unknown as Worker);
    const abort = new AbortController(), remove = vi.spyOn(abort.signal, "removeEventListener");
    const result = client.run("image.preview", input(), { signal: abort.signal });
    worker.respond({ version: PROTOCOL_VERSION, jobId: "image.preview:1", type: "SUCCESS", output: output() });
    await result;
    expect(remove).toHaveBeenCalledOnce(); abort.abort(); expect(worker.postMessage).toHaveBeenCalledTimes(1);
    client.terminate();
  });
  it("refuses a pre-cancelled job before a worker is created", async () => {
    const factory = vi.fn(), client = createWorkerClient(factory); const abort = new AbortController(); abort.abort();
    await expect(client.run("image.preview", input(), { signal: abort.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(factory).not.toHaveBeenCalled();
  });
  it("closes a preview success racing with cancellation on the page", async () => {
    const worker = new FakeWorker(), client = createWorkerClient(() => worker as unknown as Worker);
    const abort = new AbortController(), image = bitmap();
    const result = client.run("image.preview", input(), { signal: abort.signal });
    const rejected = expect(result).rejects.toMatchObject({ code: "CANCELLED" });
    abort.abort(); worker.respond({ version: PROTOCOL_VERSION, jobId: "image.preview:1", type: "SUCCESS", output: output(image) });
    await rejected; expect(image.close).toHaveBeenCalledOnce(); client.terminate();
  });
  it("closes an orphaned late preview after hard termination", async () => {
    const worker = new FakeWorker(), client = createWorkerClient(() => worker as unknown as Worker);
    const result = client.run("image.preview", input()); const rejected = expect(result).rejects.toMatchObject({ code: "CANCELLED" });
    client.terminate(); await rejected;
    const image = bitmap(); worker.respond({ version: PROTOCOL_VERSION, jobId: "image.preview:1", type: "SUCCESS", output: output(image) });
    expect(image.close).toHaveBeenCalledOnce();
  });
  it("closes worker-owned transferables when a handler completes after cancellation", async () => {
    let listener!: (event: MessageEvent<WorkerRequest>) => void;
    let release!: (value: ReturnType<typeof output>) => void;
    const postMessage = vi.fn();
    serveWorker({ postMessage, addEventListener: (_type, callback) => { listener = callback; } }, {
      "image.preview": () => new Promise((resolve) => { release = resolve; }),
    }, () => "DECODE_FAILED", (_op, value) => [(value as ReturnType<typeof output>).bitmap]);
    listener(new MessageEvent("message", { data: { version: PROTOCOL_VERSION, jobId: "x", type: "RUN", op: "image.preview", input: input() } }));
    listener(new MessageEvent("message", { data: { version: PROTOCOL_VERSION, jobId: "x", type: "CANCEL" } }));
    const image = bitmap(); release(output(image));
    await vi.waitFor(() => expect(image.close).toHaveBeenCalledOnce());
    expect(postMessage).toHaveBeenCalledWith({ version: PROTOCOL_VERSION, jobId: "x", type: "CANCELLED" });
  });
});
