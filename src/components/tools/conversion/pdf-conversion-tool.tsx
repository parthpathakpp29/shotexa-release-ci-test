"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ContinueWith } from "@/components/workspace/continue-with";
import { BitmapCanvas } from "@/components/workspace/bitmap-canvas";
import { useWorkspaceContext } from "@/components/workspace/workspace-provider";
import { useArchiveDownload } from "@/components/workspace/use-archive-download";
import { continuationsFor } from "@/config/tools";
import { checkPdfCancellation, MAX_PDF_BYTES, MAX_PDF_PAGES, openPdf, planPdfPages, renderPdfPage, type LocalPdf } from "@/core/conversion/pdf-images";
import { pdfThumbnails, type PdfThumbnails } from "@/core/conversion/pdf-thumbnails";
import { baseName, type RasterFormat } from "@/core/conversion/raster";
import { MAX_BATCH_OUTPUT_BYTES } from "@/core/batch/types";
import { downloadAsset } from "@/core/runtime/runtime";
import { formatBytes } from "@/lib/format-bytes";
import { PdfPageGrid } from "./pdf-page-grid";

type Session = { doc: LocalPdf; cache: PdfThumbnails; name: string };
type Result = { page: number; name: string; id: string; width: number; height: number; error?: never } | { page: number; name: string; id?: never; width?: never; height?: never; error: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : "PDF conversion failed. Try another document.";
async function dispose(session: Session | null) { if (session) { await session.cache.dispose(); await session.doc.destroy(); } }

export function PdfConversionTool({ initialFormat = "jpg", testId = "pdf-to-jpg" }: { initialFormat?: RasterFormat; testId?: string }) {
  const { runtime } = useWorkspaceContext();
  const [session, setSession] = useState<Session | null>(null);
  const owned = useRef<Session | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const epoch = useRef(0);
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [scale, setScale] = useState(1.5);
  const [format, setFormat] = useState<RasterFormat>(initialFormat);
  const [quality, setQuality] = useState(92);
  const [results, setResults] = useState<Result[]>([]);
  const request = useMemo(() => ({ session, selected, scale }), [session, selected, scale]);
  const [planResult, setPlan] = useState<{ request: typeof request | null; pixels?: number; error?: string }>({ request: null });
  const plan = planResult.request === request ? { ...planResult, checking: false } : { checking: true, pixels: undefined, error: undefined };
  const entries = useMemo(() => results.flatMap((item) => { const input = item.id ? runtime.registry.blob(item.id) : undefined; return input ? [{ name: item.name, input }] : []; }), [results, runtime]);
  const zip = useArchiveDownload(entries, `${testId}-images.zip`);
  const locked = busy || zip.busy;
  useEffect(() => () => { epoch.current++; active.current?.abort(); void dispose(owned.current).catch(() => undefined); owned.current = null; }, []);
  useEffect(() => {
    const { session, selected, scale } = request;
    if (!session || !selected.length) return;
    const abort = new AbortController();
    void planPdfPages(session.doc, selected, scale, abort.signal).then(({ pixels }) => { if (!abort.signal.aborted) setPlan({ request, pixels }); }).catch((cause) => { if (!abort.signal.aborted) setPlan({ request, error: errorText(cause) }); });
    return () => abort.abort();
  }, [request]);

  async function choose(file: File) {
    if (locked || active.current) return;
    const token = ++epoch.current, abort = new AbortController(); active.current = abort; setLastFile(file);
    setBusy(true); setError(""); setResults([]); setSession(null); setSelected([]); setProgress("Opening PDF…");
    const previous = owned.current; owned.current = null;
    try {
      await dispose(previous);
      const doc = await openPdf(file, { signal: abort.signal });
      if (token !== epoch.current || abort.signal.aborted) { await doc.destroy(); return; }
      const next = { doc, cache: pdfThumbnails(doc), name: file.name };
      owned.current = next; setSession(next); setSelected(Array.from({ length: doc.numPages }, (_, i) => i + 1));
      setProgress(`${doc.numPages} pages accepted. Previews load as needed.`);
    } catch (cause) { if (token === epoch.current) { if (abort.signal.aborted) setProgress("PDF opening stopped. Retry or choose another file."); else { setError(errorText(cause)); setProgress(""); } } }
    finally { if (token === epoch.current) { active.current = null; setBusy(false); } }
  }
  async function convert(retry = false) {
    if (!session || locked || active.current) return;
    const token = ++epoch.current, abort = new AbortController(); active.current = abort;
    const targets = retry ? results.filter((item) => !!item.error).map((item) => item.page) : [...selected];
    const output = new Map<number, Result>(retry ? results.map((item) => [item.page, item]) : []);
    const wasPaused = session.cache.paused;
    const publish = () => { if (token === epoch.current) setResults([...output.values()].sort((a, b) => a.page - b.page)); };
    setBusy(true); setError(""); if (!retry) setResults([]);
    try {
      setProgress("Checking selected page dimensions…");
      await session.cache.pause();
      await planPdfPages(session.doc, targets, scale, abort.signal);
      for (let i = 0; i < targets.length; i++) {
        const page = targets[i]; checkPdfCancellation(abort.signal);
        setProgress(`Rendering page ${page} (${i + 1} of ${targets.length})…`);
        try {
          const converted = await renderPdfPage(session.doc, page, scale, format, quality / 100, abort.signal);
          checkPdfCancellation(abort.signal);
          if (token !== epoch.current) break;
          const name = `${baseName(session.name)}-page-${String(page).padStart(2, "0")}.${format}`;
          const id = runtime.addConvertedImage(converted.blob, name, converted.width, converted.height, "pdf-to-jpg");
          output.set(page, { page, name, id, width: converted.width, height: converted.height });
        } catch (cause) { checkPdfCancellation(abort.signal); output.set(page, { page, name: `Page ${page}`, error: errorText(cause) }); }
        publish(); await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (token === epoch.current) {
        const ready = [...output.values()].filter((item) => item.id).length;
        if (ready) setProgress(`${ready} page${ready === 1 ? "" : "s"} converted. Completed images are available below.`);
        else { setProgress(""); setError("No pages were converted. Review the page errors and retry."); }
      }
    } catch (cause) {
      if (token === epoch.current) {
        if (abort.signal.aborted) { for (const page of targets) if (!output.get(page)?.id) output.set(page, { page, name: `Page ${page}`, error: "Not processed: conversion stopped. Retry to continue." }); setProgress("Conversion stopped. Completed images remain available."); }
        else setError(errorText(cause));
      }
    } finally {
      publish();
      if (token === epoch.current) { active.current = null; setBusy(false); if (!wasPaused && !abort.signal.aborted) session.cache.resume(); }
    }
  }
  const success = results.filter((item) => !!item.id);
  return <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6 [&_button]:min-h-11" data-testid={`${testId}-converter`}>
    <label className="block cursor-pointer rounded-xl border border-dashed border-line-strong bg-surface-3/60 p-5 text-center focus-within:ring-2 focus-within:ring-accent">
      <span className="block text-base font-semibold">Choose a PDF</span><span className="mt-1 block text-sm text-ink-3">Browser-local · up to {MAX_PDF_PAGES} pages · {MAX_PDF_BYTES / 1048576} MiB</span>
      <input type="file" accept=".pdf,application/pdf" disabled={locked} aria-label="PDF file" className="sr-only" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void choose(file); }} />
      <span className="mt-4 block truncate text-sm">{session?.name ?? lastFile?.name ?? "Choose file"}</span>
    </label>
    {!session && lastFile && !busy && <Button variant="secondary" className="mt-3" onClick={() => void choose(lastFile!)}>Retry opening PDF</Button>}
    {session && <>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p className="min-w-0 break-all font-semibold">{session.name} · {session.doc.numPages} pages</p><div className="flex gap-2"><Button size="sm" variant="secondary" disabled={locked} onClick={() => setSelected(Array.from({ length: session.doc.numPages }, (_, i) => i + 1))}>Select all</Button><Button size="sm" variant="secondary" disabled={locked} onClick={() => setSelected([])}>Clear</Button></div></div>
      <PdfPageGrid cache={session.cache} count={session.doc.numPages} selected={selected} onSelect={setSelected} disabled={locked} />
      <label className="mt-4 block text-sm font-medium">Resolution <select value={scale} disabled={locked} onChange={(e) => setScale(Number(e.target.value))} className="ml-2 min-h-11 rounded-md border border-line bg-surface px-3"><option value={1}>Standard · 1×</option><option value={1.5}>Sharp · 1.5×</option><option value={2}>High · 2×</option><option value={3}>Very high · 3×</option></select></label>
      {selected.length > 0 && <p className="mt-3 text-sm text-ink-2" data-testid="pdf-export-plan" role={plan.error ? "alert" : "status"}>{plan.checking ? "Checking selected page sizes…" : plan.error ?? `${selected.length} selected · ${((plan.pixels ?? 0) / 1_000_000).toFixed(1)} million output pixels. Final encoded file size is unknown until rendering; it depends on page content, format and quality.`}</p>}
    </>}
    <div className="mt-5 flex flex-wrap items-end gap-4"><label className="text-sm font-medium">Output format <select value={format} disabled={locked} onChange={(e) => setFormat(e.target.value as RasterFormat)} className="mt-1 block min-h-11 rounded-md border border-line bg-surface px-3"><option value="jpg">JPG</option><option value="png">PNG</option></select></label>{format === "jpg" && <label className="min-w-36 flex-1 text-sm font-medium">JPG quality: {quality}% <input type="range" min={60} max={100} value={quality} disabled={locked} onChange={(e) => setQuality(Number(e.target.value))} className="mt-3 block min-h-11 w-full" /></label>}<Button variant="primary" size="lg" disabled={!session || !selected.length || !!plan.error || !!plan.checking || locked} onClick={() => void convert()}>{busy ? "Working…" : "Convert"}</Button>{busy && <Button variant="secondary" onClick={() => { active.current?.abort(); setProgress("Stopping PDF processing…"); }}>Cancel conversion</Button>}</div>
    {progress && <p className="mt-4 text-sm text-ink-2" role="status">{progress}</p>}{error && <p className="mt-4 text-sm text-red-700" role="alert">{error}</p>}
    {results.length > 0 && <section className="mt-6 border-t border-line pt-5" aria-label="Conversion results"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="t-h3">Results ({success.length}/{results.length})</h2>{success.length > 1 && <Button variant="secondary" disabled={locked || zip.plan?.withinLimit === false} onClick={() => void zip.download()}>Download ZIP</Button>}{results.some((item) => item.error) && <Button variant="secondary" disabled={locked} onClick={() => void convert(true)}>Retry failed pages</Button>}</div>
      {success.length > 1 && <p className="mt-2 text-sm text-ink-2" data-testid="pdf-zip-plan">{zip.plan ? `ZIP size: ${formatBytes(zip.plan.bytes)} · limit ${formatBytes(MAX_BATCH_OUTPUT_BYTES)}. ${zip.plan.withinLimit ? "Includes completed pages in page order." : "Use individual downloads or export fewer pages."}` : "Checking ZIP size. Individual downloads remain available."}</p>}
      {zip.busy && <p role="status" className="mt-3 text-sm">Creating ZIP · {Math.round(zip.progress * 100)}% <Button variant="secondary" onClick={zip.cancel}>Cancel ZIP</Button></p>}{zip.error && <p role="status" className="mt-3 text-sm text-red-700">{zip.error}</p>}
      <ul className="mt-3 space-y-2">{results.map((item) => <li key={item.page} className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface-3 p-3">{item.id && <div className="h-12 w-16 shrink-0 overflow-hidden"><BitmapCanvas id={item.id} width={64} thumbnailHeight={48} label={`Converted preview of ${item.name}`} /></div>}<div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.name}</p><p className="text-xs text-ink-3">{item.error ?? `${item.width} × ${item.height} px · Added to workspace`}</p></div>{item.id && <Button size="sm" variant="secondary" onClick={() => downloadAsset(runtime, item.id!)}>Download</Button>}</li>)}</ul>{success.length > 0 && <ContinueWith tools={continuationsFor("pdf-to-jpg")} fileId={success[0].id} />}
    </section>}
  </div>;
}
