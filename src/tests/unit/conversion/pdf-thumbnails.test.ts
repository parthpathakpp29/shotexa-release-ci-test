import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PDF_THUMBNAILS, PdfThumbnails, pdfViewportPages } from "@/core/conversion/pdf-thumbnails";

const preview = () => ({ blob: new Blob(["preview"], { type: "image/png" }), width: 160, height: 240 });
afterEach(() => vi.restoreAllMocks());
describe("viewport PDF thumbnails", () => {
  it("prioritises navigation and visible pages before prefetch, without requesting distant pages", () => {
    const cards = [{ page: 1, top: -50, bottom: -5 }, { page: 2, top: 20, bottom: 80 }, { page: 3, top: 100, bottom: 160 }, { page: 80, top: 900, bottom: 950 }];
    expect(pdfViewportPages(cards, 0, 200, 2)).toEqual([2, 3, 1]);
    expect(pdfViewportPages(cards, 0, 200, 80)).not.toContain(80);
    const many = Array.from({ length: 80 }, (_, i) => ({ page: i + 1, top: 0, bottom: 100 }));
    expect(pdfViewportPages(many, 0, 100, 80)[0]).toBe(80); expect(pdfViewportPages(many, 0, 100, 80)).toHaveLength(MAX_PDF_THUMBNAILS);
  });
  it("renders only requested pages, serially, and reuses cached pages", async () => {
    let active = 0, peak = 0;
    const render = vi.fn<(page: number, signal: AbortSignal) => Promise<ReturnType<typeof preview>>>(async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return preview(); });
    const cache = new PdfThumbnails(render);
    expect(render).not.toHaveBeenCalled();
    cache.setVisible([1, 2, 3]); cache.setVisible([1, 2, 3]); await cache.idle();
    expect(render.mock.calls.map((args) => args[0])).toEqual([1, 2, 3]); expect(peak).toBe(1);
    cache.setVisible([2, 3]); await cache.idle(); expect(render).toHaveBeenCalledTimes(3);
    await cache.dispose();
  });
  it("bounds the LRU, releases evicted URLs and retains the current viewport", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const cache = new PdfThumbnails(async () => preview());
    for (let page = 1; page <= 80; page += 8) { cache.setVisible(Array.from({ length: Math.min(8, 81 - page) }, (_, i) => page + i)); await cache.idle(); expect(cache.stats().cached).toBeLessThanOrEqual(MAX_PDF_THUMBNAILS); }
    expect(cache.get(80).preview).toBeDefined(); expect(cache.get(1).preview).toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(80 - MAX_PDF_THUMBNAILS);
    await cache.dispose(); expect(revoke).toHaveBeenCalledTimes(80); expect(cache.stats().cached).toBe(0);
  });
  it("caps a malicious oversized viewport request", async () => {
    const render = vi.fn(async () => preview()); const cache = new PdfThumbnails(render);
    cache.setVisible(Array.from({ length: 80 }, (_, i) => i + 1)); await cache.idle();
    expect(render).toHaveBeenCalledTimes(MAX_PDF_THUMBNAILS); await cache.dispose();
  });
  it("pauses queued work, discards an uninterruptible late render, then resumes", async () => {
    let finish!: (result: ReturnType<typeof preview>) => void;
    const render = vi.fn<(page: number, signal: AbortSignal) => Promise<ReturnType<typeof preview>>>().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockImplementation(async () => preview());
    const cache = new PdfThumbnails(render); cache.setVisible([1, 2]);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    const stopped = cache.pause(); finish(preview()); await stopped;
    expect(cache.stats().cached).toBe(0); expect(render.mock.calls[0][1].aborted).toBe(true);
    cache.resume(); await cache.idle(); expect(cache.stats().cached).toBe(2); await cache.dispose();
  });
  it("does not publish removed pages or results after disposal", async () => {
    let finish!: (result: ReturnType<typeof preview>) => void;
    const create = vi.spyOn(URL, "createObjectURL"); const cache = new PdfThumbnails(() => new Promise((resolve) => { finish = resolve; }));
    cache.setVisible([1]); await vi.waitFor(() => expect(finish).toBeDefined());
    const stopped = cache.dispose(); finish(preview()); await stopped;
    expect(create).not.toHaveBeenCalled(); expect(cache.stats().cached).toBe(0);
  });
  it("surfaces one failure without spinning and supports explicit retry", async () => {
    const render = vi.fn().mockRejectedValueOnce(new Error("Damaged page")).mockResolvedValue(preview()); const cache = new PdfThumbnails(render);
    cache.setVisible([2]); await cache.idle(); expect(cache.get(2).error).toBe("Damaged page"); expect(render).toHaveBeenCalledTimes(1);
    cache.retry(2); await cache.idle(); expect(cache.get(2).preview).toBeDefined(); expect(cache.get(2).error).toBeUndefined(); await cache.dispose();
  });
});
