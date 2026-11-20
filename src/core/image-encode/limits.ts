/**
 * Can this image be encoded in this format, in a browser, without truncation? Pure, so the UI
 * can disable a format and explain why before anything is decoded. Same rules as every other
 * export (Spike B `chooseOutputStrategy`): JPEG/WebP need one canvas and have side limits
 * (Chromium silently crops WebP beyond 16,383 px); PNG can stream in tiles.
 */
import { DEFAULT_LIMITS } from "@/config/limits";
import { chooseOutputStrategy } from "@/core/image/output-strategy";
import type { OutputFormat } from "./formats";
import { encodeSize } from "./geometry";

export type EncodeIssue = "format-dimension" | "too-large" | "source-too-large";

export function encodeIssue(size: { width: number; height: number }, format: OutputFormat, compressionStream = true, percent = 100): EncodeIssue | null {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) return "source-too-large";
  const output = encodeSize(size, percent);
  const d = chooseOutputStrategy(
    { ...output, format, largestSourceBytes: size.width * size.height * 4 },
    { offscreenCanvas: true, compressionStream },
    DEFAULT_LIMITS,
  );
  if (d.strategy.kind === "single-canvas" || d.strategy.kind === "tiled-png") return null;
  if (d.reasons.includes("SOURCE_EXCEEDS_BUDGET")) return "source-too-large";
  if (d.reasons.includes("FORMAT_DIMENSION_LIMIT")) return "format-dimension";
  return "too-large";
}

/** The largest side a format can hold. */
export const formatMaxSide = (format: OutputFormat) => DEFAULT_LIMITS.formatMaxSide[format];
