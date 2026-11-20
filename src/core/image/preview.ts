import { DEFAULT_LIMITS } from "@/config/limits";
import { readImageSize, type ImageSize } from "./image-size";
import { PREVIEW_LIMITS, previewSize, validImageSize } from "./preview-size";

export class PreviewError extends Error {
  constructor(readonly code: "DECODE_FAILED" | "CANCELLED" | "UNSUPPORTED" | "PREVIEW_TOO_LARGE" | "PREVIEW_MEMORY_PRESSURE") { super(code); }
}
type Signal = { readonly aborted: boolean };
const check = (signal?: Signal) => { if (signal?.aborted) throw new PreviewError("CANCELLED"); };
const text = (b: Uint8Array) => String.fromCharCode(...b);

/** Read only container headers/EXIF, skipping compressed pixel chunks. Reuse the bounded TIFF reader. */
async function displaySize(blob: Blob, size: ImageSize, signal?: Signal): Promise<ImageSize & { oriented?: boolean }> {
  let offset = size.format === "jpeg" ? 2 : size.format === "png" ? 8 : 12;
  const exif = async (start: number, length: number) => {
    if (length > 1024 * 1024) return { ...size, oriented: true };
    const bytes = new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
    check(signal);
    const tiff = text(bytes.subarray(0, 6)) === "Exif\0\0" ? bytes.subarray(6) : bytes;
    const { readExif } = await import("@/core/metadata/exif");
    const orientation = readExif(tiff, "Local image orientation").orientation ?? 1;
    // Browsers differ on orientation support across containers. For oriented files, keep the
    // established decoder-derived display geometry rather than guessing or distorting pixels.
    return orientation >= 2 && orientation <= 8 ? { ...size, oriented: true } : size;
  };
  for (let count = 0; offset < blob.size && count < 512; count++) {
    check(signal);
    const header = new Uint8Array(await blob.slice(offset, offset + 8).arrayBuffer());
    if (header.length < 4) return size;
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (size.format === "jpeg") {
      if (header[0] !== 255) return size;
      const marker = header[1];
      if (marker === 0xda || marker === 0xd9) return size;
      if (marker === 0xff) { offset++; continue; }
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue; }
      const length = view.getUint16(2);
      if (length < 2 || offset + 2 + length > blob.size) return size;
      if (marker === 0xe1) {
        const prefix = new Uint8Array(await blob.slice(offset + 4, offset + 10).arrayBuffer());
        if (text(prefix) === "Exif\0\0") return exif(offset + 4, length - 2);
      }
      offset += 2 + length;
    } else {
      if (header.length < 8) return size;
      const png = size.format === "png";
      const length = view.getUint32(png ? 0 : 4, !png);
      const kind = text(header.subarray(png ? 4 : 0, png ? 8 : 4));
      const end = offset + 8 + length + (png ? 4 : length % 2);
      if (end > blob.size || end <= offset) return size;
      if (kind === (png ? "eXIf" : "EXIF")) return exif(offset + 8, length);
      if (kind === "IEND") return size;
      offset = end;
    }
  }
  if (offset < blob.size) return { ...size, oriented: true };
  return size;
}

/** Request a bounded decode directly from the Blob; never retain an avoidable full-size bitmap. */
export async function createBoundedPreview(image: Blob, options: { maxWidth?: number; maxPixels?: number; maxHeight?: number; budgetBytes?: number; signal?: Signal } = {}) {
  const { signal } = options;
  check(signal);
  if (typeof createImageBitmap !== "function") throw new PreviewError("UNSUPPORTED");
  const source = await readImageSize(image, signal);
  check(signal);
  if (!source || !validImageSize(source)) throw new PreviewError("DECODE_FAILED");
  const budget = options.budgetBytes ?? DEFAULT_LIMITS.softBudgetBytes;
  if (source.width * source.height * 4 > budget) throw new PreviewError("PREVIEW_TOO_LARGE");
  let display = await displaySize(image, source, signal);
  check(signal);
  const limits = { maxWidth: options.maxWidth ?? PREVIEW_LIMITS.maxWidth, maxPixels: options.maxPixels ?? PREVIEW_LIMITS.maxPixels, maxHeight: options.maxHeight ?? PREVIEW_LIMITS.maxHeight };
  let target = previewSize(display, limits);
  // Account for a decoder that internally needs the original plus the returned preview.
  if ((source.width * source.height + target.width * target.height) * 4 > budget) throw new PreviewError("PREVIEW_TOO_LARGE");
  let bitmap: ImageBitmap | null = null;
  try {
    try {
      bitmap = await createImageBitmap(image, display.oriented ? undefined : { resizeWidth: target.width, resizeHeight: target.height, resizeQuality: "high" });
    } catch (error) {
      check(signal);
      if (!(error instanceof TypeError) && (error as { name?: string })?.name !== "NotSupportedError") throw new PreviewError("DECODE_FAILED");
      // Compatibility for browsers without Blob resize options, within the same source budget.
      bitmap = await createImageBitmap(image);
    }
    check(signal);
    if (display.oriented) {
      display = { ...display, width: bitmap.width, height: bitmap.height };
      target = previewSize(display, limits);
      if ((bitmap.width * bitmap.height + target.width * target.height) * 4 > budget) throw new PreviewError("PREVIEW_TOO_LARGE");
    }
    if (bitmap.width !== target.width || bitmap.height !== target.height) {
      // A browser may ignore resize options. Reuse that decode once, then close it.
      const full = bitmap;
      bitmap = null;
      try {
        bitmap = await createImageBitmap(full, { resizeWidth: target.width, resizeHeight: target.height, resizeQuality: "high" });
      } finally { full.close(); }
    }
    check(signal);
    if (bitmap.width !== target.width || bitmap.height !== target.height) throw new PreviewError("DECODE_FAILED");
    const result = { bitmap, width: display.width, height: display.height };
    bitmap = null; // ownership moves to the registry/caller
    return result;
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError("DECODE_FAILED");
  } finally { bitmap?.close(); }
}
