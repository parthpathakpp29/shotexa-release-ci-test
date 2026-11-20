"use client";

import { useEffect, useRef } from "react";
import type { FileId } from "@/core/runtime/types";
import { cn } from "@/lib/cn";
import { useReleasingCanvas } from "@/lib/use-canvas-ref";
import { previewCanvasSize } from "@/core/image/preview-size";
import { useWorkspace, useWorkspaceContext } from "./workspace-provider";

/**
 * Draws a file's downscaled preview bitmap (from the AssetRegistry) into a canvas sized for
 * the display. Never touches full-resolution pixels. Re-renders when the preview changes.
 */
export function BitmapCanvas({ id, width, className, label, thumbnailHeight }: { id: FileId; width: number; className?: string; label: string; thumbnailHeight?: number }) {
  const { runtime } = useWorkspaceContext();
  const version = useWorkspace((s) => s.files[id]?.previewVersion ?? 0);
  const file = useWorkspace((s) => s.files[id]);
  const ref = useRef<HTMLCanvasElement>(null);
  const attach = useReleasingCanvas(ref);

  useEffect(() => {
    const c = ref.current;
    const bm = runtime.registry.preview(id);
    if (!c || !file) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { width: w, height: fullHeight } = previewCanvasSize(file, bm, width, dpr);
    // Draw only the visible top strip in a clipped thumbnail, preserving its scale and pixels.
    const h = thumbnailHeight && bm ? Math.min(fullHeight, Math.max(1, Math.ceil(thumbnailHeight * dpr))) : fullHeight;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (bm) {
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bm, 0, 0, w, fullHeight);
    }
  }, [runtime, id, width, version, file, thumbnailHeight]);

  if (!file) return null;
  return <canvas ref={attach} role="img" aria-label={label} className={cn("block h-auto w-full", !version && "animate-pulse bg-surface-2", className)} style={{ aspectRatio: thumbnailHeight ? undefined : `${file.width} / ${file.height}` }} />;
}
