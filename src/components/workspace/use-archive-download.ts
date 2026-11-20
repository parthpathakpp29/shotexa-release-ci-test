"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ArchiveEntry } from "@/core/archive/zip";
import { downloadBlob } from "@/core/runtime/runtime";

type Plan = { bytes: number; withinLimit: boolean; names: string[] };
type State = { key: symbol; plan: Plan | null; busy: boolean; progress: number; error: string };
const initial = (key: symbol): State => ({ key, plan: null, busy: false, progress: 0, error: "" });

/** Imperative lifetime for one immutable list of encoded results. */
class DownloadScope {
  private alive = true;
  private abort: AbortController | null = null;
  readonly key: symbol;
  constructor(entries: ArchiveEntry[]) { this.key = Symbol(`archive:${entries.length}`); }
  activate() { this.alive = true; }
  isAlive() { return this.alive; }
  begin() { if (this.abort || !this.alive) return null; this.abort = new AbortController(); return this.abort; }
  finish(abort: AbortController) { if (this.abort !== abort) return false; this.abort = null; return true; }
  cancel() { this.abort?.abort(); }
  dispose() { this.alive = false; this.cancel(); }
}

export function useArchiveDownload(entries: ArchiveEntry[], filename: string) {
  const scope = useMemo(() => new DownloadScope(entries), [entries]);
  const [state, setState] = useState(() => initial(scope.key));
  const view = state.key === scope.key ? state : initial(scope.key);
  const update = useCallback((patch: Partial<State>) => {
    if (scope.isAlive()) setState((current) => ({ ...(current.key === scope.key ? current : initial(scope.key)), ...patch }));
  }, [scope]);
  useEffect(() => {
    scope.activate();
    if (entries.length) void import("@/core/archive/zip").then(({ planZip }) => planZip(entries)).then((plan) => update({ plan })).catch(() => update({ error: "ZIP size could not be checked. Individual downloads remain available." }));
    return () => scope.dispose();
  }, [entries, scope, update]);
  async function download() {
    if (!entries.length) return;
    const abort = scope.begin(); if (!abort) return;
    update({ busy: true, progress: 0, error: "" });
    try {
      const { createZip } = await import("@/core/archive/zip");
      const result = await createZip(entries, { signal: abort.signal, onProgress: (progress) => update({ progress }) });
      if (!abort.signal.aborted && scope.isAlive()) { downloadBlob(result.blob, filename, true); return result.names; }
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      update({ error: code === "ZIP_CANCELLED" ? "ZIP creation stopped. Individual files remain available." : code === "ZIP_TOO_LARGE" ? "The ZIP exceeds the supported buffering limit. Download individual files or process fewer files." : "The ZIP could not be created. Individual downloads remain available; you can retry." });
    } finally { if (scope.finish(abort)) update({ busy: false }); }
  }
  return { ...view, download, cancel: () => scope.cancel() };
}
