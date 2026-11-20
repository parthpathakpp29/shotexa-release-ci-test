import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { createZip, planZip } from "@/core/archive/zip";
import { MAX_BATCH_OUTPUT_BYTES } from "@/core/batch/types";

class SizedBlob extends Blob { constructor(private reportedSize: number) { super(["x"]); } get size() { return this.reportedSize; } }
describe("bounded local ZIP", () => {
  it("forecasts exact bytes including UTF-8 names, collision suffixes and headers", async () => {
    const entries = [{ name: "हिंदी.png", input: new Blob(["one"]) }, { name: "हिंदी.png", input: new Blob(["two"]) }];
    const plan = await planZip(entries), zip = await createZip(entries);
    expect(plan.bytes).toBe(zip.blob.size); expect(plan.names).toEqual(zip.names); expect(plan.names[1]).toBe("हिंदी-2.png");
    const files = unzipSync(new Uint8Array(await zip.blob.arrayBuffer())); expect(new TextDecoder().decode(files[plan.names[0]])).toBe("one");
  });
  it("refuses the configured limit including overhead, without buffering large inputs", async () => {
    const input = new SizedBlob(MAX_BATCH_OUTPUT_BYTES);
    expect((await planZip([{ name: "large.png", input }])).withinLimit).toBe(false);
    await expect(createZip([{ name: "large.png", input }])).rejects.toMatchObject({ code: "ZIP_TOO_LARGE" });
  });
  it("does not trust caller-provided size hints", async () => {
    await expect(createZip([{ name: "large", input: new SizedBlob(MAX_BATCH_OUTPUT_BYTES + 1), size: 1 }])).rejects.toMatchObject({ code: "ZIP_TOO_LARGE" });
  });
  it("retains original input Blobs after cancellation and permits retry", async () => {
    const abort = new AbortController(), input = new Blob([new Uint8Array(4096).fill(17)]);
    const entries = Array.from({ length: 3 }, (_, i) => ({ name: `file-${i}`, input }));
    await expect(createZip(entries, { signal: abort.signal, onProgress: (p) => { if (p > 0) abort.abort(); } })).rejects.toMatchObject({ code: "ZIP_CANCELLED" });
    expect(input.size).toBe(4096); const zip = await createZip(entries); expect(Object.keys(unzipSync(new Uint8Array(await zip.blob.arrayBuffer())))).toEqual(entries.map((e) => e.name));
  });
  it("refuses pre-cancelled and empty work", async () => {
    const abort = new AbortController(); abort.abort(); await expect(createZip([], { signal: abort.signal })).rejects.toMatchObject({ code: "ZIP_CANCELLED" });
    await expect(createZip([])).rejects.toMatchObject({ code: "ZIP_EMPTY" });
  });
  it("unlocks native input readers after cancellation", async () => {
    class TrackedBlob extends Blob {
      streams: ReadableStream<Uint8Array>[] = [];
      stream() { const stream = super.stream(); this.streams.push(stream); return stream; }
    }
    const input = new TrackedBlob([new Uint8Array(1_000_000)]), abort = new AbortController();
    await expect(createZip([{ name: "input.png", input }], { signal: abort.signal, onProgress: (p) => { if (p > 0) abort.abort(); } })).rejects.toMatchObject({ code: "ZIP_CANCELLED" });
    expect(input.streams.length).toBeGreaterThan(0); expect(input.streams.every((stream) => !stream.locked)).toBe(true);
  });
});
