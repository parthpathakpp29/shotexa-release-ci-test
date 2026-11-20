"use client";
/* eslint-disable @next/next/no-img-element -- bounded browser-local preview URLs. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { pdfViewportPages, type PdfThumbnails } from "@/core/conversion/pdf-thumbnails";

export function PdfPageGrid({ cache, count, selected, onSelect, disabled }: { cache: PdfThumbnails; count: number; selected: number[]; onSelect(pages: number[]): void; disabled: boolean }) {
  useSyncExternalStore(cache.subscribe, cache.snapshot, () => 0);
  const grid = useRef<HTMLDivElement>(null);
  const requested = useRef<number | undefined>(undefined);
  const [jump, setJump] = useState(1);
  const update = useCallback(() => {
    const root = grid.current;
    if (!root) return;
    const bounds = root.getBoundingClientRect();
    const cards = [...root.querySelectorAll<HTMLElement>("[data-page]")].map((card) => { const box = card.getBoundingClientRect(); return { page: Number(card.dataset.page), top: box.top, bottom: box.bottom }; });
    cache.setVisible(pdfViewportPages(cards, bounds.top, bounds.bottom, requested.current));
  }, [cache]);
  useEffect(() => {
    const root = grid.current!;
    const cards = [...root.querySelectorAll<HTMLElement>("[data-page]")];
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(update, { root, rootMargin: "64px 0px" });
    cards.forEach((card) => observer?.observe(card));
    root.addEventListener("scroll", update, { passive: true }); window.addEventListener("resize", update); update();
    return () => { observer?.disconnect(); root.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [cache, count, update]);
  const stats = cache.stats();
  return <>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <label className="text-sm">Go to page <input aria-label="Go to page" className="ml-2 min-h-11 w-20 rounded-md border border-line bg-surface px-2" type="number" min={1} max={count} value={jump} onChange={(e) => setJump(Number(e.target.value))} /></label>
      <Button size="sm" variant="secondary" onClick={() => { requested.current = Math.max(1, Math.min(count, Math.round(jump) || 1)); grid.current?.querySelector<HTMLElement>(`[data-page="${requested.current}"]`)?.scrollIntoView({ block: "nearest", behavior: "instant" }); update(); }}>Go</Button>
      <Button size="sm" variant="secondary" disabled={disabled} onClick={() => cache.paused ? cache.resume() : void cache.pause()}>{cache.paused ? "Resume previews" : "Pause previews"}</Button>
      <span className="text-xs text-ink-3" role="status">{cache.paused ? "Previews paused. Selection and downloads are unchanged." : stats.pending ? "Preparing visible page previews…" : "Previews load as you scroll. Export uses the chosen resolution."}</span>
    </div>
    <div ref={grid} className="mt-3 grid max-h-80 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4" aria-label="PDF pages" data-testid="pdf-page-grid" data-cached={stats.cached} data-thumbnail-pixels={stats.pixels}>
      {Array.from({ length: count }, (_, i) => i + 1).map((n) => {
        const { preview, error, loading } = cache.get(n);
        return <div key={n} data-page={n} className="h-44 rounded-md border border-line p-2 text-center text-sm">
          <label className="flex min-h-11 cursor-pointer items-center justify-center gap-1"><input type="checkbox" disabled={disabled} checked={selected.includes(n)} onChange={() => onSelect(selected.includes(n) ? selected.filter((page) => page !== n) : [...selected, n].sort((a, b) => a - b))} aria-label={`Page ${n}`} />Page {n}</label>
          <div className="flex h-24 items-center justify-center overflow-hidden">{preview ? <img src={preview.url} alt={`Preview of PDF page ${n}`} width={preview.width} height={preview.height} className="h-24 w-full object-contain" /> : error ? <button type="button" className="min-h-11 text-xs text-accent-ink underline" disabled={disabled} onClick={() => cache.retry(n)} title={error}>Retry preview {n}</button> : <span className="text-xs text-ink-3">{loading ? "Preparing…" : cache.paused ? "Paused" : "Loads when visible"}</span>}</div>
        </div>;
      })}
    </div>
  </>;
}
