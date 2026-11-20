/**
 * Bounded OCR preparation in the image worker, or HTML canvas on canvas-less WebKit workers.
 * Decodes the screenshot ONCE, optionally cuts horizontal strips (long screenshots),
 * applies OCR-only preprocessing to copies, and encodes each part as PNG for the OCR engine.
 * The original Blob is never modified; if nothing needs changing it is passed through.
 */
import { DEFAULT_LIMITS } from "@/config/limits";
import { readImageSize } from "@/core/image/image-size";
import { applyPreprocessing, choosePreprocessing, grayToRgba, imageStats, type ImageStats, type PreprocessOutput, type PreprocessStep, type Rgba } from "./preprocess";
import { planOcrStrips } from "./strips";

export interface OcrStripPolicy { mode: "auto" | "off" | "force"; threshold: number; height: number; overlap: number }
export interface PrepareOptions {
  makeCanvas?: (width: number, height: number) => OffscreenCanvas | HTMLCanvasElement;
  budgetBytes?: number;
  stripPolicy?: OcrStripPolicy;
  /** Canvas-less workers keep histogram/upscale work off the page on WebKit too. */
  analyse?: (pixels: Rgba) => Promise<ImageStats>;
  process?: (pixels: Rgba, steps: PreprocessStep[]) => Promise<PreprocessOutput>;
  afterStep?: () => Promise<void>;
}

export interface PreparedPart {
  image: Blob;
  /** Recognised pixels per original pixel. */
  scale: number;
  /** Original-image row where this part starts. */
  y: number;
  height: number;
}

export interface PreparedImage {
  parts: PreparedPart[];
  steps: PreprocessStep[];
  stats: ImageStats;
  width: number;
  height: number;
  decodeMs: number;
  prepMs: number;
  encodeMs: number;
}

export class PrepareError extends Error {
  constructor(readonly code: "OCR_DECODE_FAILED" | "OCR_OUT_OF_MEMORY" | "CANCELLED") {
    super(code);
  }
}

type PrepareSignal = Pick<AbortSignal, "aborted"> & Partial<Pick<AbortSignal, "addEventListener" | "removeEventListener">>;

/** Release the caller promptly even when native canvas/decode work cannot be interrupted. */
function cancellable<T>(job: Promise<T>, signal?: PrepareSignal, discard?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const cancel = () => { cancelled = true; signal?.removeEventListener?.("abort", cancel); reject(new PrepareError("CANCELLED")); };
    job.then(value => {
      signal?.removeEventListener?.("abort", cancel);
      if (cancelled || signal?.aborted) { discard?.(value); reject(new PrepareError("CANCELLED")); }
      else resolve(value);
    }, error => { signal?.removeEventListener?.("abort", cancel); reject(error); });
    if (signal?.aborted) cancel();
    else signal?.addEventListener?.("abort", cancel, { once: true });
  });
}

export async function prepareForOcr(
  image: Blob,
  steps: PreprocessStep[] | "auto",
  strips?: { y: number; height: number }[],
  signal?: PrepareSignal,
  options: PrepareOptions = {},
): Promise<PreparedImage> {
  const t0 = performance.now();
  const check = () => { if (signal?.aborted) throw new PrepareError("CANCELLED"); };
  check();
  const budget = options.budgetBytes ?? DEFAULT_LIMITS.softBudgetBytes;
  const size = await readImageSize(image);
  check();
  if (!size) throw new PrepareError("OCR_DECODE_FAILED");
  if (size.width * size.height * 4 > budget) throw new PrepareError("OCR_OUT_OF_MEMORY");
  const make = options.makeCanvas ?? ((width, height) => new OffscreenCanvas(width, height));
  let bitmap: ImageBitmap;
  try {
    bitmap = await cancellable(createImageBitmap(image), signal, late => late.close());
  } catch (error) {
    if (error instanceof PrepareError) throw error;
    throw new PrepareError("OCR_DECODE_FAILED");
  }
  const { width, height } = bitmap;
  const decodeMs = performance.now() - t0;
  let prepMs = 0;
  let encodeMs = 0;
  try {
    check();
    // Stats from a bounded sample (first 4000 rows) so huge images don't need a full RGBA copy.
    const sampleH = Math.min(height, 4000, Math.max(1, Math.floor(1_048_576 / width)));
    const t1 = performance.now();
    const sample = readRows(bitmap, 0, sampleH, make);
    const stats = { ...(options.analyse ? await options.analyse(sample) : imageStats(sample)), width, height };
    await options.afterStep?.();
    check();
    const chosen = steps === "auto" ? choosePreprocessing(stats) : steps;
    prepMs += performance.now() - t1;
    const policy = options.stripPolicy;
    const useStrips = policy && (policy.mode === "force" || policy.mode === "auto" && height > policy.threshold);
    const regions = useStrips ? planOcrStrips(height, policy.height, policy.overlap) : strips?.length ? strips : [{ y: 0, height }];
    if (chosen.length === 0 && regions.length === 1) {
      return { parts: [{ image, scale: 1, y: 0, height }], steps: [], stats, width, height, decodeMs, prepMs, encodeMs };
    }
    const parts: PreparedPart[] = [];
    let applied: PreprocessStep[] = [];
    for (const r of regions) {
      check();
      const factor = chosen.includes("upscale2") ? 2 : chosen.includes("upscale1.5") ? 1.5 : 1;
      const area = width * r.height * factor * factor;
      const peak = width * height * 4 + width * sampleH * (options.analyse ? 10 : 5) + width * r.height * 9 + area * 14;
      if (area > DEFAULT_LIMITS.maxSingleCanvasArea || width * factor > DEFAULT_LIMITS.maxSingleCanvasHeight || r.height * factor > DEFAULT_LIMITS.maxSingleCanvasHeight || peak > budget) throw new PrepareError("OCR_OUT_OF_MEMORY");
      await options.afterStep?.();
      check();
      const rgba = readRows(bitmap, r.y, r.height, make);
      const t2 = performance.now();
      let px: { width: number; height: number; data: Uint8ClampedArray | Uint8Array } = rgba;
      let scale = 1;
      if (chosen.length) {
        const out = options.process ? await options.process(rgba, chosen) : applyPreprocessing(rgba, chosen);
        px = grayToRgba(out.image);
        scale = out.scale;
        applied = out.steps;
      }
      prepMs += performance.now() - t2;
      const t3 = performance.now();
      check();
      const enc = make(px.width, px.height);
      try {
        const ctx = enc.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (!ctx) throw new PrepareError("OCR_OUT_OF_MEMORY");
        ctx.putImageData(new ImageData(new Uint8ClampedArray(px.data), px.width, px.height), 0, 0);
        const encoding = "convertToBlob" in enc ? enc.convertToBlob({ type: "image/png" }) : new Promise<Blob>((resolve, reject) => enc.toBlob((blob) => blob ? resolve(blob) : reject(new PrepareError("OCR_OUT_OF_MEMORY")), "image/png"));
        const encoded = await cancellable(encoding, signal);
        check();
        parts.push({ image: encoded, scale, y: r.y, height: r.height });
      } finally { enc.width = 0; }
      encodeMs += performance.now() - t3;
    }
    return { parts, steps: applied, stats, width, height, decodeMs, prepMs, encodeMs };
  } finally {
    bitmap.close();
  }
}

function readRows(bitmap: ImageBitmap, y: number, h: number, make: NonNullable<PrepareOptions["makeCanvas"]>): ImageData {
  if (bitmap.width > DEFAULT_LIMITS.maxSingleCanvasHeight || bitmap.width * h > DEFAULT_LIMITS.maxSingleCanvasArea) throw new PrepareError("OCR_OUT_OF_MEMORY");
  const c = make(bitmap.width, h);
  const ctx = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) { c.width = 0; throw new PrepareError("OCR_OUT_OF_MEMORY"); }
  try {
    ctx.drawImage(bitmap, 0, y, bitmap.width, h, 0, 0, bitmap.width, h);
    return ctx.getImageData(0, 0, bitmap.width, h);
  } finally { c.width = 0; }
}
