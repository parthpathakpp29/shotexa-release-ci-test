import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeSource, renderDecoded } from "@/core/image-transform/render";
import { encodeImage, compareFormats } from "@/core/image-encode/reencode";
import { readImageSize } from "@/core/image/image-size";
import { FORMAT_MIME, type OutputFormat } from "@/core/image-encode/formats";
import type { FormatCandidate } from "@/core/image-encode/types";

vi.mock("@/core/image-transform/render", () => ({ decodeSource: vi.fn(), renderDecoded: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const fixture = (name: string) => readFileSync(join(process.cwd(), "src/tests/fixtures/metadata", name));
const png = (width: number, height: number) => new Blob([Uint8Array.from(PNG.sync.write(new PNG({ width, height })))], { type: "image/png" });

async function setup(format: OutputFormat = "png") {
  const blob = format === "png" ? png(40, 30) : new Blob([fixture(format === "jpeg" ? "jpeg/clean.jpg" : "webp/clean-lossless.webp")], { type: FORMAT_MIME[format] });
  const source = (await readImageSize(blob))!;
  const close = vi.fn();
  vi.mocked(decodeSource).mockResolvedValue({ ...source, close } as unknown as ImageBitmap);
  vi.mocked(renderDecoded).mockResolvedValue({ blob, ...source, strategy: "single-canvas", ms: 1 });
  return { blob, source, close };
}

describe("shared compression pipeline", () => {
  it.each(["png", "jpeg", "webp"] as const)("checks the actual %s output MIME and dimensions", async (format) => {
    const { blob, source, close } = await setup(format);
    const result = await encodeImage(blob, { source, format, quality: 0.8, background: "#ffffff" });
    expect(result).toMatchObject({ ...source, format });
    expect(result.blob.type).toBe(FORMAT_MIME[format]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses the existing transform renderer for an explicitly resized PNG", async () => {
    const { blob, source, close } = await setup();
    vi.mocked(renderDecoded).mockResolvedValue({ blob: png(20, 15), width: 20, height: 15, strategy: "single-canvas", ms: 1 });
    const result = await encodeImage(blob, { source, format: "png", quality: 0.8, background: "#ffffff", resizePercent: 50 });
    expect(result).toMatchObject({ width: 20, height: 15, format: "png" });
    expect(renderDecoded).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resize: { scaleX: 0.5, scaleY: 0.5 } }), expect.objectContaining({ quality: undefined }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects silent format fallback and changed dimensions", async () => {
    const { blob, source } = await setup();
    vi.mocked(renderDecoded).mockResolvedValue({ blob: new Blob([await blob.arrayBuffer()], { type: "image/jpeg" }), ...source, strategy: "single-canvas", ms: 1 });
    await expect(encodeImage(blob, { source, format: "jpeg", quality: 0.8, background: "#fff" })).rejects.toMatchObject({ code: "ENCODE_VERIFY_FAILED" });
    vi.mocked(renderDecoded).mockResolvedValue({ blob: png(10, 10), ...source, strategy: "single-canvas", ms: 1 });
    await expect(encodeImage(blob, { source, format: "png", quality: 0.8, background: "#fff" })).rejects.toMatchObject({ code: "ENCODE_VERIFY_FAILED" });
  });

  it("returns the highest measured fitting quality or an honest measured failure", async () => {
    const { blob, source } = await setup("jpeg");
    const bytes = await blob.arrayBuffer();
    vi.mocked(renderDecoded).mockImplementation(async (_bitmap, _transform, options) => ({
      blob: new Blob([bytes, new Uint8Array(Math.round(options.quality! * 10000))], { type: "image/jpeg" }), ...source, strategy: "single-canvas", ms: 1,
    }));
    const progress: number[] = [];
    const result = await encodeImage(blob, { source, format: "jpeg", quality: 0.9, background: "#fff", targetBytes: blob.size + 6000, onProgress: (p) => progress.push(p) });
    expect(result.quality).toBe(0.6);
    expect(result.target?.metTarget).toBe(true);
    expect(result.blob.size).toBeLessThanOrEqual(blob.size + 6000);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    const failed = await encodeImage(blob, { source, format: "jpeg", quality: 0.9, background: "#fff", targetBytes: 1 });
    expect(failed.quality).toBe(0.5);
    expect(failed.target?.metTarget).toBe(false);
    expect(failed.blob.size).toBe(blob.size + 5000);
  });

  it("does not deliver output after cancellation", async () => {
    const { blob, source, close } = await setup();
    const controller = new AbortController();
    vi.mocked(renderDecoded).mockImplementation(async () => { controller.abort(); return { blob, ...source, strategy: "single-canvas", ms: 1 }; });
    await expect(encodeImage(blob, { source, format: "png", quality: 0.8, background: "#fff", signal: controller.signal })).rejects.toMatchObject({ code: "ENCODE_CANCELLED" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("reuses a verified measured candidate without decoding or encoding again", async () => {
    const { blob, source } = await setup();
    const existing: FormatCandidate = { blob, ...source, bytes: blob.size, format: "png", quality: 0.8, strategy: "single-canvas" };
    const measured = await compareFormats(blob, { source, quality: 0.8, background: "#fff", formats: ["png"], existing: [existing] });
    expect(measured.candidates).toEqual([existing]);
    expect(decodeSource).not.toHaveBeenCalled();
    expect(renderDecoded).not.toHaveBeenCalled();
  });
});
