import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareForOcr, type PrepareOptions } from "@/core/ocr/prepare-image";
import { toGray } from "@/core/ocr/preprocess";
const header = vi.hoisted(() => ({ width: 100, height: 50 }));
vi.mock("@/core/image/image-size", () => ({ readImageSize: vi.fn(async () => ({ ...header, format: "png" })) }));
afterEach(() => vi.unstubAllGlobals());

function canvases(html = false, encode?: () => Promise<Blob>) {
  const allocated: { width: number; height: number; initialArea: number }[] = [];
  const makeCanvas: NonNullable<PrepareOptions["makeCanvas"]> = (width, height) => {
    const canvas = { width, height, initialArea: width * height, getContext: () => ({ drawImage() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) }), putImageData() {} }) };
    allocated.push(canvas);
    return Object.assign(canvas, html ? { toBlob: (done: (blob: Blob) => void) => { void (encode?.() ?? Promise.resolve(new Blob(["png"]))).then(done); } } : { convertToBlob: () => encode?.() ?? Promise.resolve(new Blob(["png"])) }) as unknown as OffscreenCanvas;
  };
  return { makeCanvas, allocated };
}
function decode(width: number, height: number) {
  header.width = width; header.height = height;
  const bitmap = { width, height, close: vi.fn() };
  const decoding = vi.fn(async () => bitmap);
  vi.stubGlobal("createImageBitmap", decoding);
  vi.stubGlobal("ImageData", class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
  return { bitmap, decoding };
}

describe("bounded OCR preparation", () => {
  it("refuses unsafe header dimensions before native decoding", async () => {
    const { decoding } = decode(20000, 20000);
    await expect(prepareForOcr(new Blob(), "auto")).rejects.toMatchObject({ code: "OCR_OUT_OF_MEMORY" });
    expect(decoding).not.toHaveBeenCalled();
  });
  it("bounds analysis pixels and reuses the original encoded image when no transform is needed", async () => {
    const { bitmap } = decode(2000, 3000), { makeCanvas, allocated } = canvases(), blob = new Blob(["original"]);
    const result = await prepareForOcr(blob, [], undefined, undefined, { makeCanvas });
    expect(allocated).toHaveLength(1); expect(allocated[0].initialArea).toBeLessThanOrEqual(1_048_576);
    expect(allocated[0].width).toBe(0); expect(result.parts[0].image).toBe(blob); expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it("HTML canvas fallback preserves strip order, dimensions and native resolution", async () => {
    const { bitmap } = decode(300, 9000), { makeCanvas, allocated } = canvases(true);
    const result = await prepareForOcr(new Blob(), [], undefined, undefined, { makeCanvas, stripPolicy: { mode: "auto", threshold: 8000, height: 2000, overlap: 240 } });
    expect(result.parts.map(p => [p.y, p.height, p.scale])).toEqual([[0, 2000, 1], [1760, 2000, 1], [3520, 2000, 1], [5280, 2000, 1], [7040, 1960, 1]]);
    expect([result.width, result.height]).toEqual([300, 9000]); expect(allocated.every(c => c.width === 0)).toBe(true); expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it("releases canvases and the source bitmap when cancellation arrives during encoding", async () => {
    const { bitmap } = decode(120, 100), abort = new AbortController(); let release!: (blob: Blob) => void;
    const { makeCanvas, allocated } = canvases(false, () => new Promise(r => { release = r; }));
    const job = prepareForOcr(new Blob(), ["gray"], undefined, abort.signal, { makeCanvas }); void job.catch(() => {});
    await vi.waitFor(() => expect(release).toBeDefined()); abort.abort();
    await expect(job).rejects.toMatchObject({ code: "CANCELLED" }); expect(bitmap.close).toHaveBeenCalledOnce(); expect(allocated.every(c => c.width === 0)).toBe(true);
    release(new Blob());
  });
  it("cancels pending native decode promptly and closes its late bitmap", async () => {
    const { bitmap } = decode(100, 100), abort = new AbortController(); let release!: (value: typeof bitmap) => void;
    vi.stubGlobal("createImageBitmap", () => new Promise(r => { release = r; }));
    const job = prepareForOcr(new Blob(), [], undefined, abort.signal); void job.catch(() => {});
    await vi.waitFor(() => expect(release).toBeDefined()); abort.abort();
    await expect(job).rejects.toMatchObject({ code: "CANCELLED" });
    release(bitmap); await vi.waitFor(() => expect(bitmap.close).toHaveBeenCalledOnce());
  });
  it("rejects oversized upscaling rather than reducing resolution silently", async () => {
    const { bitmap } = decode(4000, 2000), { makeCanvas } = canvases();
    await expect(prepareForOcr(new Blob(), ["upscale2"], undefined, undefined, { makeCanvas })).rejects.toMatchObject({ code: "OCR_OUT_OF_MEMORY" });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it("uses decoder display dimensions when planning rotated-image strips", async () => {
    const { bitmap } = decode(300, 9000); bitmap.width = 9000; bitmap.height = 300;
    const { makeCanvas } = canvases(); const blob = new Blob();
    const result = await prepareForOcr(blob, [], undefined, undefined, { makeCanvas, stripPolicy: { mode: "auto", threshold: 8000, height: 2000, overlap: 240 } });
    expect([result.width, result.height]).toEqual([9000, 300]); expect(result.parts).toHaveLength(1); expect(result.parts[0].image).toBe(blob);
  });
  it("flattens alpha onto white only in the OCR working copy", () => {
    const data = Uint8Array.from([0,0,0,0, 0,0,0,128, 255,0,0,255]), original = data.slice();
    expect([...toGray({ width: 3, height: 1, data }).data]).toEqual([255,127,76]); expect(data).toEqual(original);
  });
});
