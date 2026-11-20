import { DEFAULT_LIMITS } from "@/config/limits";

/** Preview limits only. Original files and export geometry are never changed. */
export const PREVIEW_LIMITS = { maxWidth: 1024, maxPixels: 4_000_000, maxHeight: 8192 };
export type PixelSize = { width: number; height: number };
export function validImageSize(size: PixelSize): boolean {
  return Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height) && size.width > 0 && size.height > 0 && Number.isSafeInteger(size.width * size.height);
}
export function previewSize(size: PixelSize, limits = PREVIEW_LIMITS): PixelSize {
  if (!validImageSize(size)) throw new Error("Invalid image dimensions");
  const scale = Math.min(1, limits.maxWidth / size.width, limits.maxHeight / size.height, Math.sqrt(limits.maxPixels / (size.width * size.height)));
  return { width: Math.max(1, Math.floor(size.width * scale)), height: Math.max(1, Math.floor(size.height * scale)) };
}

/** No display-sized allocation while decoding. Bound both axes and area even during zoom. */
export function previewCanvasSize(source: PixelSize, bitmap: PixelSize | undefined, cssWidth: number, dpr: number): PixelSize {
  if (!bitmap || !validImageSize(source) || !validImageSize(bitmap)) return { width: 1, height: 1 };
  if (!Number.isFinite(cssWidth) || !Number.isFinite(dpr)) return { width: 1, height: 1 };
  const ratio = source.height / source.width;
  const width = Math.max(1, Math.floor(Math.min(Math.max(1, cssWidth) * Math.min(2, Math.max(1, dpr)), bitmap.width, bitmap.height / ratio, PREVIEW_LIMITS.maxHeight / ratio, Math.sqrt(PREVIEW_LIMITS.maxPixels / ratio))));
  return { width, height: Math.max(1, Math.floor(width * ratio)) };
}

export function imageMemoryWarning(size: PixelSize, budget = DEFAULT_LIMITS.softBudgetBytes): string | null {
  if (!validImageSize(size)) return "This image has invalid dimensions and cannot be processed safely.";
  const pixels = size.width * size.height, bytes = pixels * 4;
  if (pixels <= DEFAULT_LIMITS.maxSingleCanvasArea && bytes <= budget / 2) return null;
  return `Large image: ${(pixels / 1_000_000).toFixed(1)} megapixels, about ${Math.ceil(bytes / 1048576)} MiB of decoded pixels before processing buffers. Previews are reduced; your original is unchanged. Some operations may need a smaller source, explicit resizing, PNG or splitting.`;
}
