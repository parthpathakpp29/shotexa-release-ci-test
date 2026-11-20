"use client";

/**
 * WorkspaceProvider — owns the WorkspaceRuntime for every route in the (workspace) group, so
 * files survive client-side navigation between the homepage and tools (architecture §9, §22).
 * Screenshots are never persisted: a full reload starts empty.
 *
 * Also owns the shared input surface: page-level paste (no clipboard button, no permission
 * prompt), one hidden file picker (⌘/Ctrl+O), and window-level drop protection.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { usePathname } from "next/navigation";
import { acceptsScreenshotInput } from "@/config/routes";
import { createWorkspaceRuntime, type WorkspaceRuntime } from "@/core/runtime/runtime";
import { dedupeDroppedFiles } from "@/core/runtime/drop-files";
import { messageFor } from "@/core/runtime/messages";
import type { WorkspaceActions, WorkspaceState } from "@/core/runtime/store";
import type { FileId, FileSource } from "@/core/runtime/types";
import { releaseWorkflowOutputs } from "@/core/workflows/output-registry";
import { trackAnalyticsEvent } from "@/lib/analytics";
import { imageMemoryWarning } from "@/core/image/preview-size";
import { LoadingFeedback } from "./loading-feedback";

interface WorkspaceContextValue {
  runtime: WorkspaceRuntime;
  openPicker(): void;
  /** Resolves with the ids of the screenshots actually added (rejected files are reported). */
  addFiles(files: File[], source: FileSource): Promise<FileId[]>;
  loadSample(): Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export const SAMPLE_FILES = ["/samples/sample-chat-1.png", "/samples/sample-chat-2.png"];
const ACCEPT = "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp";

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [runtime] = useState(() => createWorkspaceRuntime());
  const pathname = usePathname();
  const inputEnabled = acceptsScreenshotInput(pathname);
  const [notices, setNotices] = useState<{ id: number; text: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingDispose = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRequests = useRef(new Set<AbortController>());
  const [checking, setChecking] = useState(0);

  // Dispose when the workspace unmounts (leaving the group); survives StrictMode's double mount.
  useEffect(() => {
    if (pendingDispose.current) clearTimeout(pendingDispose.current);
    pendingDispose.current = null;
    return () => {
      pendingDispose.current = setTimeout(() => {
        releaseWorkflowOutputs(runtime);
        runtime.dispose();
      }, 0);
    };
  }, [runtime]);

  const notify = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotices([{ id, text }]);
    // A WebKit decode/preview can take longer than Chromium. Keep the single ingestion
    // summary visible long enough to be read after that work completes.
    noticeTimer.current = setTimeout(() => setNotices((current) => current[0]?.id === id ? [] : current), 8_000);
  }, []);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const addFiles = useCallback(
    async (files: File[], source: FileSource) => {
      const unique = dedupeDroppedFiles(files);
      if (!unique.length) return [];
      const abort = new AbortController();
      inputRequests.current.add(abort);
      setChecking((count) => count + unique.length);
      // Callers fire and forget (paste, drop, the picker), so nothing may reject from here.
      let r: Awaited<ReturnType<typeof runtime.ingest>>;
      try {
        r = await runtime.ingest(unique, source, { waitForPreviews: false, signal: abort.signal });
      } catch {
        if (document.visibilityState === "visible") notify(`${unique.length === 1 ? (unique[0].name || "The image") : "These images"} ${messageFor("UNREADABLE")}`);
        return [];
      } finally {
        inputRequests.current.delete(abort);
        setChecking((count) => Math.max(0, count - unique.length));
      }
      if (abort.signal.aborted) return r.added;
      const feedback = r.rejected.map((x) => `${x.name} ${messageFor(x.code)}`);
      if (r.added.length) feedback.unshift(`${r.added.length} screenshot${r.added.length === 1 ? "" : "s"} added to workspace`);
      if (r.added.some((id) => { const file = runtime.store.getState().files[id]; return file && imageMemoryWarning(file); })) feedback.push("Large images may need more memory for processing. Previews are reduced; originals are unchanged.");
      if (r.added.length && source !== "sample" && source !== "artifact") trackAnalyticsEvent("upload_completed");
      if (feedback.length) notify(feedback.join(". "));
      return r.added;
    },
    [runtime, notify],
  );

  const openPicker = useCallback(() => inputRef.current?.click(), []);

  const loadSample = useCallback(async () => {
    let files: File[];
    try {
      files = await Promise.all(
        SAMPLE_FILES.map(async (u) => {
          const b = await (await fetch(u)).blob();
          return new File([b], u.split("/").pop()!, { type: b.type || "image/png" });
        }),
      );
    } catch {
      // Offline, or the page is being left mid-download: say so only if someone is looking.
      if (document.visibilityState === "visible") notify("The sample screenshots couldn't be loaded.");
      return;
    }
    await addFiles(files, "sample");
  }, [addFiles, notify]);

  // Page-level paste: Ctrl/⌘+V anywhere (architecture §14 — listen for normal paste events).
  useEffect(() => {
    if (!inputEnabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      void addFiles(files, "paste");
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openPicker();
      }
    };
    // Dropping a file outside a drop zone must never navigate away from the workspace.
    const guard = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKey);
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, [addFiles, openPicker, inputEnabled]);

  return (
    <WorkspaceContext.Provider value={{ runtime, openPicker, addFiles, loadSample }}>
      <span className="sr-only" data-testid="workspace-input-state" data-enabled={inputEnabled} />
      {children}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="sr-only"
        suppressHydrationWarning
        tabIndex={-1}
        aria-hidden
        data-testid="file-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void addFiles(files, "picker");
        }}
      />
      <LoadingFeedback runtime={runtime} text={notices[0]?.text} checking={checking} onCancel={() => {
        inputRequests.current.forEach((request) => request.abort());
        runtime.cancelPreviews();
        notify("File processing stopped. Already accepted originals are unchanged.");
      }} />
    </WorkspaceContext.Provider>
  );
}

export function useWorkspaceContext(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspaceContext must be used inside WorkspaceProvider");
  return ctx;
}

/** Subscribe to a slice of the workspace store. */
export function useWorkspace<T>(selector: (s: WorkspaceState & WorkspaceActions) => T): T {
  return useStore(useWorkspaceContext().runtime.store, selector);
}

/** Drag-and-drop target props (validation happens in the runtime ingest). */
export function useDropTarget() {
  const { addFiles } = useWorkspaceContext();
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  return {
    over,
    props: {
      onDragEnter: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        depth.current++;
        setOver(true);
      },
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (e: React.DragEvent) => {
        e.stopPropagation();
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      },
      onDrop: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        depth.current = 0;
        setOver(false);
        void addFiles(Array.from(e.dataTransfer.files), "drop");
      },
    },
  };
}
