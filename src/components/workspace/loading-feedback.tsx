"use client";
import { useStore } from "zustand";
import type { WorkspaceRuntime } from "@/core/runtime/runtime";
import { messageFor } from "@/core/runtime/messages";

/** One live file-loading announcement, with actionable cancellation/failure states. */
export function LoadingFeedback({ runtime, text, checking, onCancel }: { runtime: WorkspaceRuntime; text?: string; checking: number; onCancel(): void }) {
  const files = useStore(runtime.store, (s) => s.files);
  const jobs = useStore(runtime.store, (s) => s.jobs);
  const pending = Object.values(files).filter((file) => !file.previewVersion);
  const running = pending.filter((file) => jobs[`preview:${file.id}`]?.status === "running");
  const failed = pending.filter((file) => jobs[`preview:${file.id}`]?.status === "failed");
  const stopped = pending.some((file) => jobs[`preview:${file.id}`]?.status === "cancelled");
  const retryable = stopped || failed.some((file) => jobs[`preview:${file.id}`]?.error !== "PREVIEW_TOO_LARGE");
  const many = runtime.registry.previewMemory().bytes > 128 * 1048576;
  if (!text && !checking && !running.length && !failed.length && !stopped && !many) return null;
  return <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 max-md:bottom-24" data-testid="file-loading-feedback">
    <div className="pointer-events-auto max-w-lg rounded-md border border-line bg-surface px-4 py-2.5 text-sm text-ink shadow-md">
      <p role="status" aria-live="polite">{text}{checking > 0 && ` Checking ${checking} file${checking === 1 ? "" : "s"}…`}{running.length > 0 && ` Preparing ${running.length} preview${running.length === 1 ? "" : "s"}. Accepted originals are available and unchanged.`}{!running.length && stopped && " Preview loading stopped. Your originals are unchanged."}{!running.length && !!failed.length && ` ${messageFor(jobs[`preview:${failed[0].id}`]?.error ?? "DECODE_FAILED")} Your originals remain in the workspace.`}</p>
      {many && <p className="mt-2 text-xs text-ink-2">Many large previews are loaded. Remove unused files before another memory-intensive operation, especially on mobile.</p>}
      {(checking > 0 || running.length > 0) && <button type="button" className="mt-2 min-h-11 rounded-sm border border-line px-3 text-sm" onClick={onCancel}>Cancel file processing</button>}
      {!checking && !running.length && retryable && <button type="button" className="mt-2 min-h-11 rounded-sm border border-line px-3 text-sm" onClick={() => void runtime.retryPreviews()}>Retry previews</button>}
    </div>
  </div>;
}
