"use client";

/**
 * Compress Screenshot and Convert Screenshot: one workspace over the shared encoder
 * (`core/image-encode`). The page never encodes pixels itself — it asks the runtime, which
 * runs the Image Worker (or the main-thread fallback) on the ORIGINAL file.
 *
 * "Check file size" encodes and shows the exact result; the primary action reuses that result
 * when the settings haven't changed (no second encode), saves an artifact and downloads it.
 * Compressor keeps the original selected for comparison. Moving a slider never re-encodes.
 */
import { AlertTriangle, Check, Copy, Download } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "@/components/ui/use-toast";
import { formatBytes } from "@/components/tools/stitch/stitch-tool";
import { Button } from "@/components/ui/button";
import { Badge, Notice, Progress } from "@/components/ui/primitives";
import { ContinueWith } from "@/components/workspace/continue-with";
import { useWorkspace, useWorkspaceContext } from "@/components/workspace/workspace-provider";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";
import { continuationsFor, TOOLS } from "@/config/tools";
import { compareSize } from "@/core/image-encode/compare";
import { FORMAT_LABEL, OUTPUT_FORMATS, supportsQuality } from "@/core/image-encode/formats";
import { encodeIssue } from "@/core/image-encode/limits";
import { customOutputName, encodeRequestKey, formatComparisonKey, resolveFormat } from "@/core/image-encode/settings";
import { resizePercent } from "@/core/image-encode/geometry";
import type { EncodeTool as EncodeToolId } from "@/core/image-encode/types";
import { messageFor } from "@/core/runtime/messages";
import { downloadAsset, type EncodeRunResult, type FormatComparisonRun } from "@/core/runtime/runtime";
import { EncodeInspector } from "./encode-inspector";
import { EncodePreview } from "./encode-preview";
import { FormatComparison } from "./format-comparison";
import { CompressorFormats } from "./compressor-formats";

type FormatPreset = { source: "image/webp" | "image/png" | "image/jpeg"; target: "png" | "jpeg"; h1: string; name: string };

export function EncodeTool({ tool, landing, preset }: { tool: EncodeToolId; landing: ReactNode; preset?: FormatPreset }) {
  const count = useWorkspace((s) => s.order.length);
  const setSettings = useWorkspace((s) => s.setEncodeSettings);
  const target = preset?.target;
  const presetName = preset?.name;
  useEffect(() => { if (target) setSettings("convert", { format: target }); }, [target, presetName, setSettings]);
  return count === 0 ? <>{landing}</> : <EncodeWorkspace tool={tool} preset={preset} />;
}

function EncodeWorkspace({ tool, preset }: { tool: EncodeToolId; preset?: FormatPreset }) {
  const { runtime } = useWorkspaceContext();
  const selectedId = useWorkspace((s) => s.selectedId);
  const file = useWorkspace((s) => (s.selectedId ? s.files[s.selectedId] : undefined));
  const settings = useWorkspace((s) => s.encode[tool]);
  const setSettings = useWorkspace((s) => s.setEncodeSettings);
  const job = useWorkspace((s) => Object.values(s.jobs).find((j) => j.kind === "encode" && j.status === "running"));
  const [run, setRun] = useState<{ key: string; result: EncodeRunResult } | null>(null);
  const [comparison, setComparison] = useState<{ key: string; result: FormatComparisonRun } | null>(null);
  const [saved, setSaved] = useState<{ id: string; result: EncodeRunResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outputNames, setOutputNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const sequence = useRef(0);
  const exporting = useRef(false);
  const active = useRef<{ id: number; sourceId: string; key: string; kind: "encode" | "formats"; abort: AbortController } | null>(null);
  useEffect(() => {
    const requests = active, generations = sequence;
    const unsubscribe = runtime.store.subscribe((state) => {
      const request = active.current;
      if (!request) return;
      const source = state.files[request.sourceId];
      const latest = source ? request.kind === "encode" ? encodeRequestKey(tool, request.sourceId, source, state.encode[tool]) : formatComparisonKey(tool, request.sourceId, source, state.encode[tool]) : null;
      if (state.selectedId !== request.sourceId || latest !== request.key) {
        request.abort.abort(); active.current = null; sequence.current++;
        setBusy(false); setNotice("The previous calculation stopped because the image or settings changed. Check the current settings when ready.");
      }
    });
    return () => { unsubscribe(); requests.current?.abort.abort(); requests.current = null; generations.current++; setBusy(false); };
  }, [runtime, tool]);
  if (!selectedId || !file) return null;
  const assetId = selectedId;
  const asset = file;
  const outputName = outputNames[assetId] ?? asset.name.replace(/\.[^.]+$/, "");
  const setOutputName = (value: string) => setOutputNames((names) => ({ ...names, [assetId]: value }));
  const format = resolveFormat(tool, settings.format, file.type);
  const targetBytes = tool === "compress" && supportsQuality(format) ? settings.targetBytes : null;
  const key = encodeRequestKey(tool, selectedId, file, settings);
  const current = run?.key === key ? run.result : null;
  const comparisonKey = formatComparisonKey(tool, selectedId, file, settings);
  const currentComparison = comparison?.key === comparisonKey && comparison.result.sourceId === selectedId ? comparison.result : null;
  // The last result for this image, shown dimmed once the settings move on.
  const shown = run && run.result.sourceId === selectedId && run.result.tool === tool ? run.result : null;
  const sourceMismatch = !!preset && file.type !== preset.source && selectedId !== saved?.id;
  const percent = tool === "compress" ? resizePercent(settings.resizePercent) : 100;
  const blocked = !!encodeIssue(file, format, typeof CompressionStream !== "undefined", percent) || sourceMismatch;
  const comparisonReason = file.width * file.height > 16_000_000 ? "Measuring three formats is limited to 16 megapixels. Check one format at a time for larger images." : OUTPUT_FORMATS.some((candidate) => encodeIssue(file, candidate, typeof CompressionStream !== "undefined", percent)) ? "At least one format exceeds browser limits at these dimensions. Choose smaller dimensions or check one format at a time." : null;
  const verb = tool === "compress" ? "Compress" : "Convert";

  async function encode(): Promise<EncodeRunResult | null> {
    const state = runtime.store.getState();
    const source = state.files[assetId];
    if (!source || state.selectedId !== assetId || encodeIssue(source, resolveFormat(tool, state.encode[tool].format, source.type), typeof CompressionStream !== "undefined", tool === "compress" ? resizePercent(state.encode[tool].resizePercent) : 100)) return null;
    const requestKey = encodeRequestKey(tool, assetId, source, state.encode[tool]);
    active.current?.abort.abort();
    const request = { id: ++sequence.current, sourceId: assetId, key: requestKey, kind: "encode" as const, abort: new AbortController() };
    active.current = request;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await runtime.encodeAsset(tool, assetId, { signal: request.abort.signal, measureAlternative: tool !== "compress" });
      if (request.abort.signal.aborted || sequence.current !== request.id) return null;
      setRun({ key: requestKey, result });
      return result;
    } catch (e) {
      const code = (e as { code?: string }).code ?? "ENCODE_MEMORY_PRESSURE";
      if (sequence.current === request.id && code !== "ENCODE_CANCELLED" && code !== "CANCELLED") setError(code);
      return null;
    } finally {
      if (sequence.current === request.id) { active.current = null; setBusy(false); }
    }
  }

  async function exportResult() {
    if (busy || blocked || exporting.current) return;
    exporting.current = true;
    try {
      const result = current ?? (await encode());
      const state = runtime.store.getState();
      if (!result || state.selectedId !== assetId || !state.files[assetId] || encodeRequestKey(tool, assetId, state.files[assetId], state.encode[tool]) !== key) return;
      const named = tool === "convert" ? { ...result, name: customOutputName(outputName, asset.name, result.format) } : result;
      const id = saved?.result.blob === named.blob && saved.result.name === named.name && state.files[saved.id] ? saved.id : runtime.saveEncoded(named);
      if (tool === "compress") runtime.store.getState().select(assetId);
      setSaved({ id, result: named });
      downloadAsset(runtime, id);
      if (named.format === "jpeg" && await runtime.hasTransparency(assetId)) toast({ type: "warning", message: "Transparency lost", description: "JPEG does not support transparency. Your chosen background color was applied." });
    } catch {
      setError("ENCODE_DOWNLOAD_FAILED");
    } finally { exporting.current = false; }
  }

  async function compareAllFormats() {
    if (busy || sourceMismatch || comparisonReason) return;
    active.current?.abort.abort();
    const request = { id: ++sequence.current, sourceId: assetId, key: comparisonKey, kind: "formats" as const, abort: new AbortController() };
    active.current = request;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await runtime.compareEncodeFormats(assetId, tool, { signal: request.abort.signal });
      if (request.abort.signal.aborted || sequence.current !== request.id) return;
      setComparison({ key: comparisonKey, result });
    } catch (e) {
      const code = (e as { code?: string }).code ?? "ENCODE_MEMORY_PRESSURE";
      if (sequence.current === request.id && code !== "ENCODE_CANCELLED" && code !== "CANCELLED") setError(code);
    } finally {
      if (sequence.current === request.id) { active.current = null; setBusy(false); }
    }
  }

  function selectCandidate(candidate: EncodeRunResult) {
    if (busy || candidate.sourceId !== assetId) return;
    setSettings(tool, { format: candidate.format });
    const state = runtime.store.getState();
    if (tool === "compress" && candidate.format !== "png" && state.encode[tool].targetBytes) { void encode(); return; }
    setRun({ key: encodeRequestKey(tool, assetId, asset, state.encode[tool]), result: candidate });
    setError(null);
  }

  function cancel() {
    active.current?.abort.abort(); active.current = null; sequence.current++;
    runtime.cancelEncode(); setBusy(false); setNotice(`${tool === "compress" ? "Compression" : "Conversion"} cancelled. Your original and any earlier measured result are unchanged.`);
  }

  async function copyPng() {
    if (!current || current.format !== "png") return;
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      toast({ type: "error", message: "Copy PNG is not supported in this browser. Download remains available." });
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": current.blob })]);
      toast({ type: "success", message: "PNG copied to the clipboard." });
    } catch {
      toast({ type: "error", message: "The browser blocked clipboard image access. Download the PNG instead." });
    }
  }

  const status = busy ? (
    <Badge tone="accent" dot>
      Encoding…
    </Badge>
  ) : (
    <Badge tone="accent" dot>
      → {FORMAT_LABEL[format]}
      {targetBytes ? ` · target ${Math.round(targetBytes / 1024)} KB` : supportsQuality(format) ? ` ${Math.round(settings.quality * 100)}%` : ""}
    </Badge>
  );

  return (
    <WorkspaceShell
      tool={tool}
      status={status}
      exportAction={{ label: tool === "compress" ? current ? current.target?.metTarget === false ? "Download measured result" : "Download compressed image" : "Compress & download" : `Convert to ${FORMAT_LABEL[format]}`, onClick: exportResult, disabled: blocked, busy }}
      fileHint={`Select any screenshot or Shotexa result to ${verb.toLowerCase()} it. Your original is never changed — the result is a new file.`}
      inspectorTitle={`${verb} settings`}
      canvas={
        <>
          <h1 className="sr-only">{preset?.h1 ?? TOOLS[tool].seo.h1}</h1>
          {sourceMismatch && <Notice tone="warning" icon={<AlertTriangle />} title={`${preset.name} needs the right source format`} className="mb-4">This image is {file.type || "an unknown format"}. Select a {preset.name.split(" to ")[0]} image in Files, or add one to this workspace. Your current image stays here.</Notice>}
          {error && (
            <Notice tone="error" icon={<AlertTriangle />} title={`${verb} didn’t finish`} className="mb-4">
              {error === "ENCODE_DOWNLOAD_FAILED" ? "The download could not start. The measured result remains available; try Download again." : messageFor(error)}
            </Notice>
          )}
          {notice && <p role="status" className="mb-3 rounded-md border border-line bg-surface p-3 text-sm text-ink-2">{notice}</p>}
          {busy && (
            <div className="mb-4 rounded-lg border border-accent-line bg-accent-soft p-4" aria-live="polite">
              <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                <span className="font-medium text-accent-ink">Encoding at {percent === 100 ? "original" : `${percent}%`} dimensions on your device…</span>
                <span className="t-mono text-accent-ink">{job?.progress == null ? "" : `${Math.round(job.progress * 100)}%`}</span>
              </div>
              <Progress value={job?.progress ?? null} label="Encoding progress" />
              <Button variant="secondary" className="mt-3 min-h-11" onClick={cancel}>Cancel {tool === "compress" ? "compression" : "conversion"}</Button>
            </div>
          )}
          <EncodePreview
            key={selectedId}
            tool={tool}
            assetId={selectedId}
            format={format}
            result={shown}
            stale={!!shown && !current}
            busy={busy}
            blocked={blocked}
            onRun={() => void encode()}
            onResize={(value) => { setSettings(tool, { resizePercent: value }); void encode(); }}
            onApply={(apply) => {
              // A suggestion changes settings only because the user chose "Try it".
              setSettings(tool, { format: tool === "compress" && apply.format === format && settings.format === "same" ? "same" : apply.format, ...(apply.quality === undefined ? {} : { quality: apply.quality }) });
              void encode();
            }}
          />
          {tool === "compress" && <CompressorFormats comparison={currentComparison} current={current} originalBytes={file.bytes} busy={busy} reason={comparisonReason} onMeasure={() => void compareAllFormats()} onSelect={selectCandidate} />}
          {tool === "convert" && (
            <>
              <FormatComparison comparison={currentComparison} selected={current} originalBytes={file.bytes} busy={busy} blocked={sourceMismatch} onCompare={() => void compareAllFormats()} onSelect={selectCandidate} />
              {current?.format === "png" && (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button variant="secondary" onClick={() => void copyPng()} className="max-md:h-11" data-testid="copy-output-png"><Copy /> Copy PNG</Button>
                </div>
              )}
            </>
          )}
        </>
      }
      inspector={<EncodeInspector key={selectedId} tool={tool} assetId={selectedId} format={format} presetFormat={preset?.target} busy={busy} outputName={tool === "convert" ? outputName : undefined} onOutputName={tool === "convert" ? setOutputName : undefined} onRun={() => void encode()} />}
      below={saved && saved.result.tool === tool && <SavedResult tool={tool} saved={saved} onDownload={() => { try { downloadAsset(runtime, saved.id); } catch { setError("ENCODE_DOWNLOAD_FAILED"); } }} />}
    />
  );
}

function SavedResult({ tool, saved, onDownload }: { tool: EncodeToolId; saved: { id: string; result: EncodeRunResult }; onDownload(): void }) {
  const exists = useWorkspace((s) => !!s.files[saved.id]);
  if (!exists) return null;
  const r = saved.result;
  const c = compareSize(r.originalBytes, r.bytes);
  return (
    <div className="mt-6" data-testid="encode-result">
      <Notice
        tone={c.outcome === "larger" || r.target?.metTarget === false ? "warning" : "success"}
        icon={<Check />}
        title={tool === "compress" ? r.target?.metTarget === false ? "Image ready; target could not be reached" : "Compressed image ready" : `Converted to ${FORMAT_LABEL[r.format]}`}
        actions={
          <Button variant="secondary" onClick={onDownload}>
            <Download /> Download again
          </Button>
        }
      >
        <span className="t-mono text-[12px]">
          {r.name} · {r.width} × {r.height} px · {formatBytes(r.bytes)}
        </span>
        <span className="block">
          {c.outcome === "smaller"
            ? `${formatBytes(c.saved)} smaller than the original (${c.percent}% saved).`
            : c.outcome === "larger"
              ? `${formatBytes(c.delta)} larger than the original (+${c.percent}%).`
              : "The same size as the original."}{" "}
          Added to this workspace as a new file; the original is unchanged.
        </span>
      </Notice>
      <ContinueWith tools={continuationsFor(tool)} fileId={saved.id} />
    </div>
  );
}
