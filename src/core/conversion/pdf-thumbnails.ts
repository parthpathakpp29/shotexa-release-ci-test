import { checkPdfCancellation, renderPdfPage, type LocalPdf } from "./pdf-images";

export const MAX_PDF_THUMBNAILS = 24;
/** Prioritise a navigation target and visible cards before adjacent prefetch cards. */
export function pdfViewportPages(cards: { page: number; top: number; bottom: number }[], top: number, bottom: number, preferred?: number) {
  const center = (top + bottom) / 2;
  const priority = (card: typeof cards[number]) => card.page === preferred ? 0 : card.bottom > top && card.top < bottom ? 1 : 2;
  return cards.filter((card) => card.bottom >= top - 64 && card.top <= bottom + 64)
    .sort((a, b) => priority(a) - priority(b) || Math.abs((a.top + a.bottom) / 2 - center) - Math.abs((b.top + b.bottom) / 2 - center) || a.page - b.page)
    .slice(0, MAX_PDF_THUMBNAILS).map((card) => card.page);
}
type Preview = { url: string; width: number; height: number };
type Renderer = (page: number, signal: AbortSignal) => Promise<{ blob: Blob; width: number; height: number }>;

/** A serial viewport queue. Owns only a bounded LRU of thumbnail URLs, never export images. */
export class PdfThumbnails {
  private cache = new Map<number, Preview>();
  private errors = new Map<number, string>();
  private wanted: number[] = [];
  private listeners = new Set<() => void>();
  private revision = 0;
  private work: Promise<void> | null = null;
  private current: { page: number; abort: AbortController } | null = null;
  private disposed = false;
  paused = false;
  constructor(private readonly render: Renderer) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.revision;
  private changed() { this.revision++; this.listeners.forEach((listener) => listener()); }
  get(page: number) { return { preview: this.cache.get(page), error: this.errors.get(page), loading: this.current?.page === page }; }
  stats() { return { cached: this.cache.size, pixels: [...this.cache.values()].reduce((n, p) => n + p.width * p.height, 0), pending: this.wanted.filter((p) => !this.cache.has(p) && !this.errors.has(p)).length }; }
  setVisible(pages: number[]) {
    if (this.disposed) return;
    this.wanted = [...new Set(pages)].filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_PDF_THUMBNAILS);
    for (const n of this.wanted) { const cached = this.cache.get(n); if (cached) { this.cache.delete(n); this.cache.set(n, cached); } }
    if (this.current && !this.wanted.includes(this.current.page)) this.current.abort.abort();
    this.start();
  }
  private start() {
    if (this.work || this.paused || this.disposed) return;
    this.work = Promise.resolve().then(() => this.pump()).finally(() => {
      this.work = null;
      if (!this.paused && !this.disposed && this.wanted.some((n) => !this.cache.has(n) && !this.errors.has(n))) this.start();
    });
  }
  private async pump() {
    while (!this.paused && !this.disposed) {
      const page = this.wanted.find((n) => !this.cache.has(n) && !this.errors.has(n));
      if (page === undefined) break;
      const abort = new AbortController();
      this.current = { page, abort }; this.changed();
      try {
        // Native page rendering/encoding already yields. An extra timer per tiny preview
        // can be heavily throttled on WebKit/background pages and delay a navigation target.
        checkPdfCancellation(abort.signal);
        const result = await this.render(page, abort.signal);
        if (this.disposed || this.paused || abort.signal.aborted || !this.wanted.includes(page)) continue;
        while (this.cache.size >= MAX_PDF_THUMBNAILS) {
          const oldest = [...this.cache.keys()].find((n) => !this.wanted.includes(n));
          if (oldest === undefined) break;
          URL.revokeObjectURL(this.cache.get(oldest)!.url); this.cache.delete(oldest);
        }
        this.cache.set(page, { url: URL.createObjectURL(result.blob), width: result.width, height: result.height });
      } catch (error) {
        if (!this.disposed && !abort.signal.aborted) this.errors.set(page, error instanceof Error ? error.message : "Preview unavailable. Retry or export this page.");
      } finally { this.current = null; if (!this.disposed) this.changed(); }
    }
  }
  async pause() { this.paused = true; this.current?.abort.abort(); this.changed(); await this.work; }
  resume() { if (!this.disposed) { this.paused = false; this.changed(); this.start(); } }
  retry(page: number) { this.errors.delete(page); this.setVisible([page, ...this.wanted]); this.resume(); }
  async idle() { await this.work; }
  async dispose() {
    this.disposed = true; this.paused = true; this.current?.abort.abort();
    for (const preview of this.cache.values()) URL.revokeObjectURL(preview.url);
    this.cache.clear(); this.errors.clear(); this.wanted = []; this.listeners.clear();
    await this.work;
  }
}

export function pdfThumbnails(doc: LocalPdf) {
  return new PdfThumbnails(async (n, signal) => {
    checkPdfCancellation(signal);
    const page = await doc.getPage(n);
    let scale: number;
    try { const size = page.getViewport({ scale: 1 }); scale = Math.min(0.22, 240 / Math.max(size.width, size.height)); }
    finally { page.cleanup(); }
    return renderPdfPage(doc, n, scale, "png", 0.92, signal);
  });
}
