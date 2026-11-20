import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoundedPreview } from "@/core/image/preview";
import { previewCanvasSize, previewSize } from "@/core/image/preview-size";
import { readImageSize } from "@/core/image/image-size";
import { minimalOrientationTiff } from "@/core/metadata/exif";

/** Header-only unit fixture; real compressed pixels are exercised in browser tests. */
function header(width: number, height: number) {
  const bytes = new Uint8Array(45), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12); view.setUint32(16, width); view.setUint32(20, height);
  bytes.set([73, 69, 78, 68], 37);
  return new Blob([bytes], { type: "image/png" });
}
const bitmap = (width: number, height: number) => ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;
afterEach(() => vi.unstubAllGlobals());

describe("bounded shared previews", () => {
  it("rechecks the budget against actual oriented geometry before allocating a second bitmap", async () => {
    const original = new Uint8Array(await header(15000, 2000).arrayBuffer()), tiff = minimalOrientationTiff(6);
    const bytes = new Uint8Array(33 + 12 + tiff.length + 12), view = new DataView(bytes.buffer);
    bytes.set(original.subarray(0, 33)); view.setUint32(33, tiff.length); bytes.set([101, 88, 73, 102], 37); bytes.set(tiff, 41);
    bytes.set(original.subarray(33), 45 + tiff.length);
    const full = bitmap(2000, 15000), decode = vi.fn(async () => full); vi.stubGlobal("createImageBitmap", decode);
    await expect(createBoundedPreview(new Blob([bytes], { type: "image/png" }), { budgetBytes: 128 * 1048576 })).rejects.toMatchObject({ code: "PREVIEW_TOO_LARGE" });
    expect(decode).toHaveBeenCalledOnce(); expect(full.close).toHaveBeenCalledOnce();
  });
  it("requests one bounded Blob decode, retaining original dimensions", async () => {
    const input = header(1200, 10000), target = previewSize({ width: 1200, height: 10000 });
    const decode = vi.fn(async () => bitmap(target.width, target.height)); vi.stubGlobal("createImageBitmap", decode);
    const result = await createBoundedPreview(input);
    expect(decode).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledWith(input, { resizeWidth: target.width, resizeHeight: target.height, resizeQuality: "high" });
    expect(result).toMatchObject({ width: 1200, height: 10000 });
    expect(result.bitmap.width * result.bitmap.height).toBeLessThanOrEqual(4000000);
  });
  it("bounds placeholders, zoom canvases, extreme aspect ratios and invalid headers", () => {
    expect(previewCanvasSize({ width: 100, height: 100000 }, undefined, 10000, 2)).toEqual({ width: 1, height: 1 });
    const size = previewSize({ width: 100, height: 100000 });
    expect(size.height).toBeLessThanOrEqual(8192);
    expect(previewCanvasSize({ width: 100, height: 100000 }, size, 10000, 2).height).toBeLessThanOrEqual(8192);
    expect(() => previewSize({ width: 0, height: 1 })).toThrow();
  });
  it("refuses an unsafe source before invoking a decoder", async () => {
    const decode = vi.fn(); vi.stubGlobal("createImageBitmap", decode);
    await expect(createBoundedPreview(header(10000, 10000))).rejects.toMatchObject({ code: "PREVIEW_TOO_LARGE" });
    expect(decode).not.toHaveBeenCalled();
  });
  it("reuses an ignored-resize decode once and releases it", async () => {
    const input = header(1200, 10000), size = previewSize({ width: 1200, height: 10000 });
    const full = bitmap(1200, 10000), small = bitmap(size.width, size.height);
    const decode = vi.fn().mockResolvedValueOnce(full).mockResolvedValueOnce(small); vi.stubGlobal("createImageBitmap", decode);
    expect((await createBoundedPreview(input)).bitmap).toBe(small);
    expect(decode).toHaveBeenCalledTimes(2); expect(full.close).toHaveBeenCalledOnce(); expect(small.close).not.toHaveBeenCalled();
  });
  it("does not retry corrupt images as a second full decode", async () => {
    const decode = vi.fn().mockRejectedValue(Object.assign(new Error("corrupt"), { name: "InvalidStateError" })); vi.stubGlobal("createImageBitmap", decode);
    await expect(createBoundedPreview(header(40, 30))).rejects.toMatchObject({ code: "DECODE_FAILED" });
    expect(decode).toHaveBeenCalledOnce();
  });
  it("closes a bitmap returned after cancellation", async () => {
    const controller = new AbortController(), image = bitmap(40, 30);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => { controller.abort(); return image; }));
    await expect(createBoundedPreview(header(40, 30), { signal: controller.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(image.close).toHaveBeenCalledOnce();
  });
  for (const format of ["png", "jpeg", "webp"]) for (const rotated of [false, true]) {
    it(`preserves browser-derived ${format} EXIF display geometry (rotation applied: ${rotated})`, async () => {
      const name = format === "jpeg" ? "orientation-6.jpg" : `exif-orientation-6.${format}`;
      const input = new Blob([Uint8Array.from(readFileSync(join(process.cwd(), "src/tests/fixtures/metadata", format, name)))], { type: format === "jpeg" ? "image/jpeg" : `image/${format}` });
      const source = (await readImageSize(input))!;
      const actual = rotated ? { width: source.height, height: source.width } : source;
      const decode = vi.fn(async () => bitmap(actual.width, actual.height)); vi.stubGlobal("createImageBitmap", decode);
      const result = await createBoundedPreview(input);
      expect(result).toMatchObject({ width: actual.width, height: actual.height });
      expect(decode.mock.calls[0]).toEqual([input, undefined]);
    });
  }
});
