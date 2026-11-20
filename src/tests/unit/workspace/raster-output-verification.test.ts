import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRemovedBackground } from "@/core/background-removal/render";
import { DEFAULT_BACKGROUND_REMOVAL } from "@/core/background-removal/types";
import { DEFAULT_BEAUTIFY } from "@/core/beautify/presets";
import { renderBeautified } from "@/core/beautify/render";
import { composeCombine } from "@/core/combine/compose";
import { planCombine } from "@/core/combine/layout";
import { renderTransform } from "@/core/image-transform/render";
import { IDENTITY_TRANSFORM } from "@/core/image-transform/transform";
import type { OutputFormat } from "@/core/image-encode/formats";

// Canvas drawing is covered by the browser fixtures. Simulate a browser encoder returning
// valid PNG bytes so each real renderer's post-encode checks can run in Node.
vi.mock("@/core/beautify/draw", () => ({ drawBeautified: vi.fn() }));

const source = { width: 12, height: 8 };
const png = (width: number, height: number, type = "image/png") =>
  new Blob([Uint8Array.from(PNG.sync.write(new PNG({ width, height })))], { type });
const input = png(source.width, source.height);

function canvasEncoder({ widthOffset = 0, type = "image/png" } = {}) {
  return (width: number, height: number) => ({
    width,
    height,
    getContext: () => ({
      clearRect() {}, drawImage() {}, fillRect() {}, putImageData() {},
      restore() {}, save() {}, scale() {}, setTransform() {},
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    }),
    convertToBlob: async () => png(width + widthOffset, height, type),
  }) as unknown as OffscreenCanvas;
}

type CanvasFactory = ReturnType<typeof canvasEncoder>;
const renderers = [
  { name: "Editor / Annotation / Split", error: "EDITOR_EXPORT_VERIFY_FAILED", run: (format: OutputFormat, createCanvas: CanvasFactory) =>
    renderTransform(input, IDENTITY_TRANSFORM, { source, format, createCanvas }) },
  { name: "Combine", error: "COMBINE_EXPORT_VERIFY_FAILED", run: (format: OutputFormat, createCanvas: CanvasFactory) =>
    composeCombine([input, input], planCombine([source, source]), { format, createCanvas }) },
  { name: "Beautifier", error: "ENCODE_VERIFY_FAILED", run: (format: OutputFormat, createCanvas: CanvasFactory) =>
    renderBeautified(input, DEFAULT_BEAUTIFY, { source, format, createCanvas }) },
  { name: "Background Remover", error: "BACKGROUND_EXPORT_FAILED", run: (format: OutputFormat, createCanvas: CanvasFactory) =>
    renderRemovedBackground(input, {
      source, format, createCanvas, settings: DEFAULT_BACKGROUND_REMOVAL,
      mask: { width: 1, height: 1, data: Uint8ClampedArray.of(255) },
    }) },
];

beforeEach(() => vi.stubGlobal("createImageBitmap", async () => ({ ...source, close() {} })));
afterEach(() => vi.unstubAllGlobals());

describe.each(renderers)("$name output", ({ error, run }) => {
  it("refuses PNG fallback when WebP was requested", async () => {
    await expect(run("webp", canvasEncoder())).rejects.toMatchObject({ code: error });
  });

  it("refuses PNG bytes labeled as WebP", async () => {
    await expect(run("webp", canvasEncoder({ type: "image/webp" }))).rejects.toMatchObject({ code: error });
  });

  it("refuses an output that was silently cropped", async () => {
    await expect(run("png", canvasEncoder({ widthOffset: -1 }))).rejects.toMatchObject({ code: error });
  });

  it("returns a matching PNG with decodable dimensions and transparent pixels", async () => {
    const result = await run("png", canvasEncoder());
    expect(result.blob.type).toBe("image/png");
    const decoded = PNG.sync.read(Buffer.from(await result.blob.arrayBuffer()));
    expect([decoded.width, decoded.height]).toEqual([result.width, result.height]);
    expect(decoded.data[3]).toBe(0);
  });
});
