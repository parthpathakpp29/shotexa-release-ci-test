"use client";
/* eslint-disable @next/next/no-img-element -- browser-local encoded Blob inspection needs native pixels. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { BitmapCanvas } from "@/components/workspace/bitmap-canvas";
import { useWorkspaceContext } from "@/components/workspace/workspace-provider";
import { useObjectUrls } from "@/lib/object-url";
import { pointerCentredScroll, viewportShortcut, zoomStep, type ViewportZoom } from "@/core/viewport/viewport";
import type { EncodeRunResult } from "@/core/runtime/runtime";
import type { WorkspaceFile } from "@/core/runtime/types";

/** Bound simultaneous native image decodes. Large exports still use the shared tiled renderer. */
export const MAX_DETAIL_PIXELS = 8_000_000;

export function CompressorComparison({ file, result, paneWidth, stale, placeholder }: { file: WorkspaceFile; result: EncodeRunResult | null; paneWidth: number; stale: boolean; placeholder: ReactNode }) {
  const { runtime } = useWorkspaceContext();
  const [zoom, setZoom] = useState<ViewportZoom>("fit");
  const left = useRef<HTMLDivElement>(null), right = useRef<HTMLDivElement>(null);
  const programmed = useRef(new WeakMap<HTMLDivElement, { x: number; y: number }>());
  const pendingPositions = useRef<{ element: HTMLDivElement; x: number; y: number }[] | null>(null);
  const source = runtime.registry.blob(file.id);
  const native = file.width * file.height <= MAX_DETAIL_PIXELS && (!result || result.width * result.height <= MAX_DETAIL_PIXELS);
  const blobs = useMemo(() => native ? [source, result?.blob].filter((blob): blob is Blob => !!blob) : [], [native, source, result?.blob]);
  const urls = useObjectUrls(blobs);
  const resultUrl = urls[1];
  const fit = Math.min(1, paneWidth / file.width);
  const mode = native ? zoom : "fit";
  // Apply the zoom anchor after React updates image widths, before paint or the next pan.
  // Remember exact programmatic positions so their scroll events cannot feed back into the peer.
  useLayoutEffect(() => {
    let positions = pendingPositions.current;
    pendingPositions.current = null;
    // A result can arrive after the original was already zoomed and panned.
    const a = left.current, b = right.current;
    if (!positions && mode !== "fit" && resultUrl && a && b) positions = [{ element: b,
      x: (a.scrollLeft + a.clientWidth / 2) / Math.max(1, a.scrollWidth) * b.scrollWidth - b.clientWidth / 2,
      y: (a.scrollTop + a.clientHeight / 2) / Math.max(1, a.scrollHeight) * b.scrollHeight - b.clientHeight / 2,
    }];
    positions?.forEach(({ element, x, y }) => {
      element.scrollTo(x, y);
      programmed.current.set(element, { x: element.scrollLeft, y: element.scrollTop });
    });
  }, [mode, resultUrl]);

  function changeZoom(next: ViewportZoom) {
    if (next === mode) return;
    const positions = [left.current, right.current].map((element, index) => {
      const width = index === 0 ? file.width : result?.width ?? file.width;
      const oldScale = mode === "fit" ? Math.min(1, paneWidth / width) : mode;
      const newScale = next === "fit" ? Math.min(1, paneWidth / width) : next;
      return element ? { element, x: pointerCentredScroll(element.scrollLeft, element.clientWidth / 2, oldScale, newScale), y: pointerCentredScroll(element.scrollTop, element.clientHeight / 2, oldScale, newScale) } : null;
    });
    pendingPositions.current = positions.filter((position) => position !== null);
    setZoom(next);
  }

  function syncScroll(from: RefObject<HTMLDivElement | null>, to: RefObject<HTMLDivElement | null>) {
    const a = from.current, b = to.current;
    if (!a || !b || mode === "fit") return;
    const expected = programmed.current.get(a);
    programmed.current.delete(a);
    if (expected && Math.abs(a.scrollLeft - expected.x) < 0.5 && Math.abs(a.scrollTop - expected.y) < 0.5) return;
    b.scrollLeft = (a.scrollLeft + a.clientWidth / 2) / Math.max(1, a.scrollWidth) * b.scrollWidth - b.clientWidth / 2;
    b.scrollTop = (a.scrollTop + a.clientHeight / 2) / Math.max(1, a.scrollHeight) * b.scrollHeight - b.clientHeight / 2;
    programmed.current.set(b, { x: b.scrollLeft, y: b.scrollTop });
  }

  const image = (isOriginal: boolean) => {
    const size = isOriginal ? file : result!;
    const width = mode === "fit" ? Math.min(paneWidth, size.width) : size.width * mode;
    if (!native) return isOriginal
      ? <div style={{ width }}><BitmapCanvas id={file.id} width={width} label="Original image, reduced preview" /></div>
      : <BoundedResult blob={result!.blob} width={width} size={size} />;
    const url = urls[isOriginal ? 0 : 1];
    return url ? <img src={url} alt={isOriginal ? `Original ${file.name}` : "Encoded result"} width={size.width} height={size.height} style={{ width, height: "auto", maxWidth: "none" }} className="block" data-testid={isOriginal ? "encode-original-image" : "encode-result-image"} /> : null;
  };

  return <div onKeyDown={(event) => {
    if (!native) return;
    const shortcut = viewportShortcut(event.nativeEvent);
    if (shortcut === "fit" || shortcut === "actual" || shortcut === "zoom-in" || shortcut === "zoom-out") {
      event.preventDefault();
      changeZoom(shortcut === "fit" ? "fit" : shortcut === "actual" ? 1 : zoomStep(mode, fit, shortcut === "zoom-in" ? 1 : -1));
    }
  }}>
    <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Comparison zoom">
      <Button size="sm" variant={mode === "fit" ? "primary" : "secondary"} onClick={() => changeZoom("fit")} aria-pressed={mode === "fit"} className="min-h-11 min-w-11 max-md:min-h-11">Fit</Button>
      <Button size="sm" variant={mode === 1 ? "primary" : "secondary"} onClick={() => changeZoom(1)} aria-pressed={mode === 1} disabled={!native} className="min-h-11 min-w-11 max-md:min-h-11">100%</Button>
      <Button size="sm" variant={mode === 2 ? "primary" : "secondary"} onClick={() => changeZoom(2)} aria-pressed={mode === 2} disabled={!native} className="min-h-11 min-w-11 max-md:min-h-11">200%</Button>
      <Button size="sm" aria-label="Zoom out comparison" disabled={!native || mode === "fit"} onClick={() => changeZoom(zoomStep(mode, fit, -1))} className="min-h-11 min-w-11 max-md:min-h-11">−</Button>
      <Button size="sm" aria-label="Zoom in comparison" disabled={!native || (typeof mode === "number" && mode >= 8)} onClick={() => changeZoom(zoomStep(mode, fit, 1))} className="min-h-11 min-w-11 max-md:min-h-11">+</Button>
      <span role="status" className="text-xs text-ink-3" data-testid="compressor-zoom">{mode === "fit" ? "Fit" : `${Math.round(mode * 100)}%`} · scroll views together</span>
    </div>
    <p className="mb-3 text-xs leading-5 text-ink-3">{native ? "100% shows one image pixel per CSS pixel from the original and the actual encoded file. Use +, −, 0 for Fit, or 1 for 100% while the comparison is focused." : "Reduced previews: full-resolution comparison is limited to 8 megapixels per image to bound memory. Export dimensions are unaffected."}{result && (result.width !== file.width || result.height !== file.height) && " The result has fewer pixels; 100% uses each image’s own dimensions."}</p>
    <div className="grid grid-cols-2 gap-2 sm:gap-4">
      <figure className="min-w-0 rounded-lg border border-line bg-surface p-2 shadow-xs sm:p-3">
        <figcaption className="mb-2 text-sm font-medium">Original</figcaption>
        <div ref={left} role="region" aria-label="Original comparison view" tabIndex={0} onScroll={() => syncScroll(left, right)} className="max-h-[55dvh] min-h-40 overflow-auto rounded-sm bg-checker outline-offset-2">{image(true)}</div>
      </figure>
      <figure className="min-w-0 rounded-lg border border-line bg-surface p-2 shadow-xs sm:p-3" data-testid="encode-result-pane">
        <figcaption className="mb-2 text-sm font-medium">{stale ? "Previous result · settings changed" : "Result"}</figcaption>
        <div ref={right} role="region" aria-label="Result comparison view" tabIndex={0} onScroll={() => syncScroll(right, left)} className={`max-h-[55dvh] min-h-40 overflow-auto rounded-sm bg-checker outline-offset-2 ${stale ? "opacity-50" : ""}`}>{result ? image(false) : placeholder}</div>
      </figure>
    </div>
  </div>;
}

function BoundedResult({ blob, width, size }: { blob: Blob; width: number; size: { width: number; height: number } }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState<Blob | null>(null);
  useEffect(() => {
    let live = true;
    const element = canvas.current;
    const scale = Math.min(1, 1024 / size.width, 8192 / size.height, Math.sqrt(1_000_000 / (size.width * size.height)));
    void createImageBitmap(blob, { resizeWidth: Math.max(1, Math.round(size.width * scale)), resizeHeight: Math.max(1, Math.round(size.height * scale)), resizeQuality: "high" }).then((bitmap) => {
      try {
        if (!live || !element) return;
        element.width = bitmap.width; element.height = bitmap.height;
        const context = element.getContext("2d");
        if (!context) throw new Error("Preview unavailable");
        context.drawImage(bitmap, 0, 0);
      } finally { bitmap.close(); }
    }).catch(() => { if (live) setFailed(blob); });
    return () => { live = false; if (element) { element.width = 0; element.height = 0; } };
  }, [blob, size.width, size.height]);
  return failed === blob ? <p role="status" className="p-3 text-sm">Result preview unavailable. The verified file remains available for download.</p> : <canvas ref={canvas} role="img" aria-label="Encoded result, reduced preview" style={{ width, height: "auto", aspectRatio: `${size.width}/${size.height}` }} className="block" />;
}
