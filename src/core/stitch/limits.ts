import { DEFAULT_LIMITS, type ProcessingLimits } from "@/config/limits";
import type { ImageDims } from "./types";

/** Refuse unsafe analysis before decoding. Analysis never changes source/output pixels. */
export function stitchAnalysisIssue(a: ImageDims, b: ImageDims, offscreenCanvas: boolean, limits: ProcessingLimits = DEFAULT_LIMITS): "source-memory" | "fallback-canvas" | null {
  const pixelsA = a.width * a.height, pixelsB = b.width * b.height;
  // Worker analysis retains both decoded sources. DOM fallback additionally reads
  // one full RGBA canvas and a gray buffer, retaining A's gray while reading B.
  const estimate = offscreenCanvas ? (pixelsA + pixelsB) * 4 : Math.max(pixelsA * 13, pixelsA + pixelsB * 13);
  if (estimate > limits.softBudgetBytes) return "source-memory";
  if (!offscreenCanvas && [a, b].some(d => d.width * d.height > limits.maxSingleCanvasArea || Math.max(d.width, d.height) > limits.maxSingleCanvasHeight)) return "fallback-canvas";
  return null;
}
