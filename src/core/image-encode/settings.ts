/**
 * Compress and Convert settings: defaults, which output format a setting means for a given
 * input, and result file names.
 */
import { clampQuality, FORMAT_EXT, formatOfMime, withExtension, type OutputFormat } from "./formats";
import { DEFAULT_BACKGROUND } from "./encode";
import type { EncodeSettings, EncodeTool } from "./types";
import { resizePercent } from "./geometry";

/** Starting quality caps. The user inspects the measured result before choosing a trade-off. */
export const DEFAULT_ENCODE_SETTINGS: Record<EncodeTool, EncodeSettings> = {
  compress: { format: "same", quality: 0.8, background: DEFAULT_BACKGROUND, targetBytes: null },
  convert: { format: "auto", quality: 0.92, background: DEFAULT_BACKGROUND, targetBytes: null },
};

export const TARGET_SIZE_PRESETS = [
  { bytes: 200 * 1024, label: "200 KB" },
  { bytes: 500 * 1024, label: "500 KB" },
  { bytes: 1024 * 1024, label: "1 MB" },
] as const;

/** Background presets for JPEG output (plus a custom colour). */
export const BACKGROUND_PRESETS = [
  { value: "#ffffff", label: "White" },
  { value: "#000000", label: "Black" },
  { value: "#f7f1e3", label: "Cream" },
] as const;

/** The natural conversion target: PNG → JPEG, JPEG → PNG, WebP → PNG. */
export function autoTarget(input: OutputFormat): OutputFormat {
  return input === "png" ? "jpeg" : "png";
}

/**
 * The output format a setting means for this input. Compress never changes the format unless
 * the user picked one. Convert's auto choice changes format, while an explicit choice may
 * re-encode the current format after the user measures all candidates.
 */
export function resolveFormat(tool: EncodeTool, setting: EncodeSettings["format"], inputMime: string): OutputFormat {
  const input = formatOfMime(inputMime) ?? "png";
  if (tool === "compress") return setting === "same" || setting === "auto" ? input : setting;
  return setting === "auto" || setting === "same" ? autoTarget(input) : setting;
}

export function normaliseSettings(s: EncodeSettings): EncodeSettings {
  const targetBytes = Number.isFinite(s.targetBytes) && (s.targetBytes ?? 0) >= 1024 ? Math.round(s.targetBytes!) : null;
  return { ...s, ...(s.resizePercent === undefined ? {} : { resizePercent: resizePercent(s.resizePercent) }), quality: clampQuality(s.quality), background: /^#[0-9a-f]{6}$/i.test(s.background) ? s.background.toLowerCase() : DEFAULT_BACKGROUND, targetBytes };
}

/** Only settings that change encoded pixels/bytes belong in a result key. */
export function encodeRequestKey(tool: EncodeTool, id: string, source: { width: number; height: number; type: string }, settings: EncodeSettings): string {
  const format = resolveFormat(tool, settings.format, source.type);
  return JSON.stringify([tool, id, source.width, source.height, format, format === "png" ? null : settings.quality,
    format === "jpeg" ? settings.background : null, tool === "compress" && format !== "png" ? settings.targetBytes : null,
    tool === "compress" ? resizePercent(settings.resizePercent) : 100]);
}

export function formatComparisonKey(tool: EncodeTool, id: string, source: { width: number; height: number }, settings: EncodeSettings): string {
  return JSON.stringify(["formats", tool, id, source.width, source.height, settings.quality, settings.background, tool === "compress" ? resizePercent(settings.resizePercent) : 100]);
}

/** `compressed-shot.jpg` for Compress; `shot.webp` for Convert. */
export function encodedName(tool: EncodeTool, name: string, format: OutputFormat): string {
  const base = name.replace(/^compressed-/, "");
  return tool === "compress" ? `compressed-${withExtension(base, format)}` : withExtension(name, format);
}

/** Cross-platform-safe user filename. The selected encoder always owns the extension. */
export function customOutputName(value: string, fallback: string, format: OutputFormat): string {
  const stem = value
    .replace(/\.[^.]+$/, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  return `${stem || fallback.replace(/\.[^.]+$/, "") || "image"}.${FORMAT_EXT[format]}`;
}
