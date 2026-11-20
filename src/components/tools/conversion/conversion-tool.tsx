"use client";
/* eslint-disable @next/next/no-img-element -- previews use short-lived local Blob URLs, not remote images. */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ContinueWith } from "@/components/workspace/continue-with";
import { useWorkspaceContext } from "@/components/workspace/workspace-provider";
import { continuationsFor } from "@/config/tools";
import { PdfConversionTool } from "./pdf-conversion-tool";
import { baseName, type RasterFormat } from "@/core/conversion/raster";
import { convertSvg, sanitizeSvg } from "@/core/conversion/svg";
import { downloadAsset, downloadBlob } from "@/core/runtime/runtime";

type Kind = "pdf-to-jpg" | "svg-to-png";
type Result = { id: string; name: string; width: number; height: number; error?: never } | { id?: never; name: string; error: string; width?: never; height?: never };

function errorText(error: unknown): string { return error instanceof Error ? error.message : "Conversion failed. Try another file."; }

export function ConversionTool(props: { tool: Kind; initialFormat?: RasterFormat; testId?: string }) {
  return props.tool === "pdf-to-jpg" ? <PdfConversionTool initialFormat={props.initialFormat} testId={props.testId} /> : <SvgConversionTool {...props} />;
}

function SvgConversionTool({ tool, initialFormat, testId }: { tool: Kind; initialFormat?: RasterFormat; testId?: string }) {
  const { runtime } = useWorkspaceContext();
  const [format, setFormat] = useState<RasterFormat>(initialFormat ?? (tool === "svg-to-png" ? "png" : "jpg"));
  const [quality, setQuality] = useState(92);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const previewUrls = useRef<string[]>([]);
  const svgSelection = useRef(0);
  const [svg, setSvg] = useState("");
  const [svgName, setSvgName] = useState("");
  const [svgPreview, setSvgPreview] = useState("");
  const [originalSize, setOriginalSize] = useState({ width: 1, height: 1 });
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [lockRatio, setLockRatio] = useState(true);
  const [background, setBackground] = useState("#ffffff");

  useEffect(() => () => {
    svgSelection.current++;
    previewUrls.current.forEach(URL.revokeObjectURL);
  }, []);

  const clearSvgPreview = () => {
    previewUrls.current.forEach(URL.revokeObjectURL);
    previewUrls.current = [];
    setSvgPreview("");
  };
  const addResult = (blob: Blob, name: string, width: number, height: number): Result => {
    const id = runtime.addConvertedImage(blob, name, width, height, tool);
    return { id, name, width, height };
  };

  async function chooseFiles(files: FileList | null) {
    if (!files?.length || busy) return;
    const selection = ++svgSelection.current;
    setError(""); setResults([]); setProgress("");
    const file = files[0];
    clearSvgPreview();
    setSvg(""); setSvgName("");
    if (file.size > 2_000_000) { setError("Choose an SVG under 2 MB."); return; }
    try {
      const text = await file.text();
      if (selection !== svgSelection.current) return;
      const parsed = sanitizeSvg(text);
      const url = URL.createObjectURL(new Blob([parsed.svg], { type: "image/svg+xml" }));
      previewUrls.current.push(url);
      setSvgPreview(url); setSvg(parsed.svg); setSvgName(file.name);
      setOriginalSize({ width: parsed.width, height: parsed.height });
      setWidth(Math.round(parsed.width)); setHeight(Math.round(parsed.height));
    } catch (e) {
      if (selection === svgSelection.current) setError(errorText(e));
    }
  }

  async function convert() {
    if (busy) return;
    setBusy(true); setError(""); setResults([]);
    const output: Result[] = [];
    try {
      if (!svg) throw new Error("Choose an SVG first.");
      setProgress("Rasterizing SVG…");
      const blob = await convertSvg(svg, width, height, format, background, quality / 100);
      output.push(addResult(blob, `${baseName(svgName)}.${format}`, width, height));
      setResults([...output]);
      if (output.every((item) => item.error)) setError("No images were converted. See the file errors below.");
    } catch (e) { setError(errorText(e)); }
    finally { setProgress(""); setBusy(false); }
  }

  async function downloadZip() {
    const entries = results.flatMap((item) => {
      if (!item.id) return [];
      const blob = runtime.registry.blob(item.id);
      return blob ? [{ name: item.name, input: blob }] : [];
    });
    if (!entries.length) return;
    try {
      setBusy(true);
      const archive = await (await import("@/core/archive/zip")).createZip(entries);
      downloadBlob(archive.blob, `${testId ?? tool}-images.zip`);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  const success = results.filter((item) => !!item.id);
  const accept = tool === "pdf-to-jpg" ? ".pdf,application/pdf" : ".svg,image/svg+xml";
  const ready = !!svg;
  const chosen = svgName || "No SVG selected";
  return <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6" data-testid={`${testId ?? tool}-converter`}>
    <label className="block cursor-pointer rounded-xl border border-dashed border-line-strong bg-surface-3/60 p-5 text-center hover:border-accent focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30">
      <span className="block text-base font-semibold text-ink">{tool === "pdf-to-jpg" ? "Choose a PDF" : "Choose an SVG"}</span>
      <span className="t-body-sm mt-1 block text-ink-3">Processed in this browser only</span>
      <input type="file" accept={accept} disabled={busy} aria-label={tool === "pdf-to-jpg" ? "PDF file" : "SVG file"} onChange={(event) => { void chooseFiles(event.target.files); event.target.value = ""; }} className="sr-only" />
      <span className="mt-4 flex items-center justify-center gap-3 text-sm"><span className="rounded-md bg-accent px-4 py-2 font-semibold text-white">Choose file</span><span className="max-w-48 truncate text-ink-2" title={chosen}>{chosen}</span></span>
    </label>
    {tool === "svg-to-png" && svg && <>
      <div className="mt-4 flex min-h-40 items-center justify-center rounded-lg border border-line bg-[linear-gradient(45deg,#eee_25%,transparent_25%),linear-gradient(-45deg,#eee_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#eee_75%),linear-gradient(-45deg,transparent_75%,#eee_75%)] bg-[length:20px_20px]">{svgPreview && <img src={svgPreview} alt="Sanitized SVG preview" className="max-h-48 max-w-full object-contain" />}</div>
      <p className="t-body-sm mt-2 text-ink-2">{svgName} · source {originalSize.width} × {originalSize.height}</p>
      <div className="mt-4 grid grid-cols-2 gap-3"><label className="text-sm font-medium">Width <input type="number" min={1} max={16384} value={width} onChange={(e) => { const next = Number(e.target.value); setWidth(next); if (lockRatio) setHeight(Math.max(1, Math.round(next * originalSize.height / originalSize.width))); }} className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2" /></label><label className="text-sm font-medium">Height <input type="number" min={1} max={16384} value={height} onChange={(e) => { const next = Number(e.target.value); setHeight(next); if (lockRatio) setWidth(Math.max(1, Math.round(next * originalSize.width / originalSize.height))); }} className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2" /></label></div>
      <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={lockRatio} onChange={(e) => setLockRatio(e.target.checked)} /> Preserve aspect ratio</label>
      {format === "jpg" && <label className="mt-3 flex items-center gap-2 text-sm">JPG background <input type="color" value={background} onChange={(e) => setBackground(e.target.value)} aria-label="JPG background color" /></label>}
    </>}
    <div className="mt-5 flex flex-wrap items-end gap-4">
      <label className="text-sm font-medium">Output format <select value={format} onChange={(e) => setFormat(e.target.value as RasterFormat)} className="mt-1 block min-h-11 rounded-md border border-line bg-surface px-3"><option value="jpg">JPG</option><option value="png">PNG</option></select></label>
      {format === "jpg" && <label className="min-w-36 flex-1 text-sm font-medium">JPG quality: {quality}% <input type="range" min={60} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} className="mt-3 block w-full" /></label>}
      <Button variant="primary" size="lg" disabled={!ready || busy} onClick={() => void convert()}>{busy ? "Working…" : "Convert"}</Button>
    </div>
    {(progress || error) && <p role={error ? "alert" : "status"} className={`mt-4 text-sm ${error ? "text-red-700" : "text-ink-2"}`}>{error || progress}</p>}
    {results.length > 0 && <section className="mt-6 border-t border-line pt-5" aria-label="Conversion results"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="t-h3">Results ({success.length}/{results.length})</h2>{success.length > 1 && <Button variant="secondary" disabled={busy} onClick={() => void downloadZip()}>Download ZIP</Button>}</div><ul className="mt-3 space-y-2">{results.map((item, index) => <li key={`${item.name}-${index}`} className="flex items-center gap-3 rounded-md border border-line bg-surface-3 p-3">{item.id && <img src={runtime.registry.objectUrl(item.id)} alt={`Converted preview of ${item.name}`} loading="lazy" className="h-12 w-16 shrink-0 rounded-sm border border-line bg-white object-contain" />}<div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.name}</p><p className="text-xs text-ink-3">{item.error ?? `${item.width} × ${item.height} px · Added to workspace`}</p></div>{item.id && <Button size="sm" variant="secondary" onClick={() => downloadAsset(runtime, item.id!)}>Download</Button>}</li>)}</ul>{success.length > 0 && <ContinueWith tools={continuationsFor(tool)} fileId={success[0].id} />}</section>}
  </div>;
}
