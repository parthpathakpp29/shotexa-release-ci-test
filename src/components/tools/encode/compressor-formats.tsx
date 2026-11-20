"use client";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/components/tools/stitch/stitch-tool";
import { FORMAT_LABEL } from "@/core/image-encode/formats";
import type { EncodeRunResult, FormatComparisonRun } from "@/core/runtime/runtime";

export function CompressorFormats({ comparison, current, originalBytes, busy, reason, onMeasure, onSelect }: { comparison: FormatComparisonRun | null; current: EncodeRunResult | null; originalBytes: number; busy: boolean; reason: string | null; onMeasure(): void; onSelect(candidate: EncodeRunResult): void }) {
  const smallest = comparison?.candidates.reduce((best, candidate) => candidate.bytes < best.bytes ? candidate : best);
  return <section className="mt-4 rounded-lg border border-line bg-surface p-4" aria-label="Measured format comparison" data-testid="compressor-formats">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">Choose format with measured sizes</h2><p className="mt-1 text-sm text-ink-2">PNG keeps detail losslessly. JPEG and WebP trade detail for size; their quality percentages are different encoder settings, not visual accuracy scores.</p></div><Button variant="secondary" disabled={busy || !!reason} onClick={onMeasure} className="min-h-11" data-testid="compare-formats">{comparison ? "Measure again" : "Measure all formats"}</Button></div>
    {reason && <p className="mt-3 text-sm text-ink-3" role="status">{reason}</p>}
    {smallest && <>
      <p role="status" className="mt-3 text-sm font-medium" data-testid="format-comparison-summary">{FORMAT_LABEL[smallest.format]} produced the smallest measured file: {formatBytes(smallest.bytes)}.{smallest.bytes >= originalBytes ? " Keeping the original is at least as small." : " Inspect small text at 100% before choosing a lossy result."}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3" data-testid="format-comparison">{comparison!.candidates.map((candidate) => <div className="rounded-md border border-line p-3" key={candidate.format} data-testid={`format-candidate-${candidate.format}`}>
        <h3 className="text-sm font-semibold">{FORMAT_LABEL[candidate.format]}{current?.blob === candidate.blob ? " · selected" : ""}</h3>
        <p className="mt-1 font-mono text-sm">{formatBytes(candidate.bytes)}</p><p className="mt-1 text-xs text-ink-3">{candidate.bytes.toLocaleString()} bytes · {candidate.width} × {candidate.height}</p>
        <p className="mt-2 text-xs leading-5 text-ink-2">{candidate.format === "png" ? "Lossless encoding; transparency supported. Resizing still changes pixels." : candidate.format === "jpeg" ? `${Math.round(candidate.quality * 100)}% JPEG setting. Lossy; transparent areas are filled with your background color.` : `${Math.round(candidate.quality * 100)}% WebP setting. Lossy color encoding; transparency supported.`}</p>
        <Button className="mt-3 min-h-11 w-full" variant="secondary" onClick={() => onSelect(candidate)} disabled={busy} aria-label={`Use measured ${FORMAT_LABEL[candidate.format]}`}>Use {FORMAT_LABEL[candidate.format]}</Button>
      </div>)}</div>
      <p className="mt-3 text-xs text-ink-3">These are actual files at the selected dimensions and quality cap, before any target-size search. A format changes only when you choose it.</p>
    </>}
  </section>;
}
