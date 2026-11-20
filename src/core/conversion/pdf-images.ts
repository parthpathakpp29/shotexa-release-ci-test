import { assertRasterSize, encodeCanvas, releaseCanvas, type RasterFormat } from "./raster";

export const MAX_PDF_BYTES = 60 * 1024 * 1024;
export const MAX_PDF_PAGES = 80;
export const MAX_PDF_EXPORT_PIXELS = 80_000_000;
export const checkPdfCancellation = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException("PDF processing cancelled", "AbortError"); };

export async function openPdf(file: File, options: { signal?: AbortSignal; onProgress?(loaded: number, total: number): void } = {}) {
  const { signal } = options;
  checkPdfCancellation(signal);
  if (file.size < 8 || file.size > MAX_PDF_BYTES) throw new Error("Choose a PDF under 60 MB.");
  const head = new TextDecoder().decode(await file.slice(0, 8).arrayBuffer());
  if (!head.startsWith("%PDF-")) throw new Error("This is not a valid PDF file.");
  const pdfjs = await import("pdfjs-dist");
  checkPdfCancellation(signal);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const data = new Uint8Array(await file.arrayBuffer());
  checkPdfCancellation(signal);
  const task = pdfjs.getDocument({ data, isEvalSupported: false, disableAutoFetch: true, disableStream: true });
  const cancel = () => { void task.destroy().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => { if (!signal?.aborted) options.onProgress?.(loaded, total); };
  try {
    const doc = await task.promise;
    if (signal?.aborted) { await doc.destroy(); checkPdfCancellation(signal); }
    if (doc.numPages > MAX_PDF_PAGES) {
      await doc.destroy();
      throw new Error(`This PDF has more than ${MAX_PDF_PAGES} pages. Split it into smaller documents first.`);
    }
    return doc;
  } catch (error) {
    await task.destroy().catch(() => undefined);
    checkPdfCancellation(signal);
    if (error instanceof Error && /more than/.test(error.message)) throw error;
    if (error instanceof Error && /password/i.test(error.name + error.message)) throw new Error("This PDF is password protected. Unlock it before converting.");
    throw new Error("This PDF could not be opened. It may be damaged or unsupported.");
  } finally { signal?.removeEventListener("abort", cancel); }
}

export type LocalPdf = Awaited<ReturnType<typeof openPdf>>;

/** Header/page geometry only; no thumbnails or output encoding. Never silently resizes. */
export async function planPdfPages(doc: LocalPdf, pages: number[], scale: number, signal?: AbortSignal) {
  const sizes: { page: number; width: number; height: number }[] = [];
  let pixels = 0;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("Choose a valid PDF resolution.");
  for (const n of pages) {
    checkPdfCancellation(signal);
    const page = await doc.getPage(n);
    try {
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
      assertRasterSize(width, height);
      pixels += width * height;
      if (pixels > MAX_PDF_EXPORT_PIXELS) throw new Error("This selection exceeds the safe batch size (80 million pixels). Select fewer pages or explicitly choose a lower resolution.");
      sizes.push({ page: n, width, height });
    } finally { page.cleanup(); }
    // At most 80 geometry-only entries; getPage already yields for worker metadata reads.
  }
  checkPdfCancellation(signal);
  return { sizes, pixels };
}

export async function renderPdfPage(doc: LocalPdf, pageNumber: number, scale: number, format: RasterFormat, quality = 0.92, signal?: AbortSignal): Promise<{ blob: Blob; width: number; height: number }> {
  checkPdfCancellation(signal);
  const page = await doc.getPage(pageNumber);
  const canvas = document.createElement("canvas");
  let render: ReturnType<typeof page.render> | undefined;
  const cancel = () => render?.cancel();
  try {
    checkPdfCancellation(signal);
    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    assertRasterSize(width, height);
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: format === "png" });
    if (!context) throw new Error("Canvas is unavailable in this browser.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    render = page.render({ canvasContext: context, viewport });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    await render.promise;
    checkPdfCancellation(signal);
    const blob = await encodeCanvas(canvas, format, quality);
    checkPdfCancellation(signal);
    return { blob, width, height };
  } catch (error) {
    checkPdfCancellation(signal);
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    page.cleanup();
    releaseCanvas(canvas);
  }
}
