import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readImageSize } from "@/core/image/image-size";

const jpeg = Uint8Array.from(readFileSync(join(process.cwd(), "src/tests/fixtures/metadata/jpeg/clean.jpg")));
function paddedJpeg() {
  const segment = new Uint8Array(65537); segment.set([255, 226, 255, 255]);
  return new Blob([jpeg.subarray(0, 2), ...Array.from({ length: 20 }, () => segment), jpeg.subarray(2)], { type: "image/jpeg" });
}
describe("bounded image header reads", () => {
  it("finds JPEG dimensions beyond 1 MiB of metadata without reading the whole file", async () => {
    const blob = paddedJpeg(), slice = vi.spyOn(blob, "slice");
    expect(await readImageSize(blob)).toEqual(await readImageSize(new Blob([jpeg])));
    const reads = slice.mock.results.map((result) => (result.value as Blob).size);
    expect(Math.max(...reads)).toBeLessThanOrEqual(65536);
    expect(reads.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(70000);
  });
  it("stops between marker reads when cancelled", async () => {
    const blob = paddedJpeg(), original = blob.slice.bind(blob), abort = new AbortController(); let calls = 0;
    vi.spyOn(blob, "slice").mockImplementation((start, end) => { if (++calls === 3) abort.abort(); return original(start, end); });
    expect(await readImageSize(blob, abort.signal)).toBeNull(); expect(calls).toBe(3);
  });
  it("refuses malformed marker bounds without allocating their declared lengths", async () => {
    const bytes = new Uint8Array(70000); bytes.set([255, 216, 255, 226, 255, 255]);
    expect(await readImageSize(new Blob([bytes]))).toBeNull();
  });
});
