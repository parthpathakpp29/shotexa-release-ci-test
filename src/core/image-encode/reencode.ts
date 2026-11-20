/**
 * Compress / Convert: decode the ORIGINAL file once and re-encode it at original dimensions,
 * or explicitly chosen smaller dimensions, in the selected format and quality.
 *
 * The pixels go through the Screenshot Editor pipeline with an identity transform
 * (`renderDecoded`): a 1:1 copy or explicit resize, the same single-canvas / tiled-PNG choice
 * and memory limits, the JPEG background, post-encode dimension verification and canvas
 * cleanup as every other export. Nothing here draws or encodes on its own.
 */
import { decodeSource, renderDecoded } from "@/core/image-transform/render";
import { IDENTITY_TRANSFORM } from "@/core/image-transform/transform";
import { EditorError, type EditorErrorCode } from "@/core/image-transform/types";
import { encoderQuality, FORMAT_MIME, OUTPUT_FORMATS, type OutputFormat } from "./formats";
import { encodeIssue } from "./limits";
import { MAX_TARGET_ATTEMPTS, searchTargetSize } from "./target-size";
import { EncodeError, type EncodeErrorCode, type EncodeOptions, type EncodeResult, type FormatCandidate, type FormatComparisonResult } from "./types";
import { encodeSize } from "./geometry";
import { readImageSize } from "@/core/image/image-size";
import { sniffImageType } from "@/core/image/validate";

/** Largest image the optional size probe runs on (it is a second full encode). */
export const PROBE_MAX_PIXELS = 16_000_000;
/** Three retained candidate Blobs are deliberately limited more tightly than one normal export. */
export const FORMAT_COMPARE_MAX_PIXELS = 16_000_000;

const FROM_EDITOR: Record<EditorErrorCode, EncodeErrorCode> = {
  EDITOR_INVALID_TRANSFORM: "ENCODE_TOO_LARGE",
  EDITOR_DECODE_FAILED: "ENCODE_DECODE_FAILED",
  EDITOR_SOURCE_MISMATCH: "ENCODE_SOURCE_MISMATCH",
  EDITOR_MEMORY_PRESSURE: "ENCODE_MEMORY_PRESSURE",
  EDITOR_EXPORT_TOO_LARGE: "ENCODE_TOO_LARGE",
  EDITOR_EXPORT_VERIFY_FAILED: "ENCODE_VERIFY_FAILED",
  EDITOR_CANCELLED: "ENCODE_CANCELLED",
};

export function toEncodeError(error: unknown): EncodeError {
  if (error instanceof EncodeError) return error;
  if (error instanceof EditorError) return new EncodeError(FROM_EDITOR[error.code], error.message);
  if (error instanceof RangeError) return new EncodeError("ENCODE_MEMORY_PRESSURE");
  return new EncodeError("ENCODE_MEMORY_PRESSURE", String(error));
}

/** Throws a controlled error, before decoding anything, if the format can't hold this image. */
export function assertEncodable(size: { width: number; height: number }, format: EncodeOptions["format"], compressionStream = typeof CompressionStream !== "undefined", percent = 100) {
  const issue = encodeIssue(size, format, compressionStream, percent);
  if (issue === "format-dimension") throw new EncodeError("ENCODE_FORMAT_TOO_LARGE", `${format} ${size.width}x${size.height}`);
  if (issue) throw new EncodeError("ENCODE_TOO_LARGE", issue);
}

async function verifyEncoded(blob: Blob, format: OutputFormat, expected: { width: number; height: number }) {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const size = await readImageSize(blob);
  if (blob.type !== FORMAT_MIME[format] || sniffImageType(head) !== FORMAT_MIME[format] ||
    !size || size.width !== expected.width || size.height !== expected.height) throw new EncodeError("ENCODE_VERIFY_FAILED");
}

const transformFor = (o: Pick<EncodeOptions, "source" | "resizePercent">) => {
  const size = encodeSize(o.source, o.resizePercent);
  return { ...IDENTITY_TRANSFORM, resize: size.width === o.source.width && size.height === o.source.height ? null : { scaleX: size.width / o.source.width, scaleY: size.height / o.source.height } };
};

const yieldForInput = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function encodeImage(image: Blob, o: EncodeOptions): Promise<EncodeResult> {
  assertEncodable(o.source, o.format, typeof CompressionStream !== "undefined", o.resizePercent);
  const started = performance.now();
  let bitmap: ImageBitmap | null = null;
  try {
    // Checked before every Blob read: a read started while the page is being left is refused.
    if (o.signal?.aborted) throw new EncodeError("ENCODE_CANCELLED");
    bitmap = await decodeSource(image, o.source);
    const decoded = bitmap;
    const transform = transformFor(o);
    const expected = encodeSize(o.source, o.resizePercent);
    const common = { source: o.source, background: o.background, createCanvas: o.createCanvas, yieldBetweenTiles: o.yieldBetweenTiles, signal: o.signal };
    const render = async (quality: number) => {
      if (o.signal?.aborted) throw new EncodeError("ENCODE_CANCELLED");
      const output = await renderDecoded(decoded, transform, {
        ...common,
        format: o.format,
        quality: encoderQuality(o.format, quality),
      });
      await verifyEncoded(output.blob, o.format, expected);
      if (o.signal?.aborted) throw new EncodeError("ENCODE_CANCELLED");
      return output;
    };
    const targetEnabled = !!o.targetBytes && o.targetBytes > 0 && o.format !== "png";
    let quality = o.quality;
    let main;
    let target: EncodeResult["target"];
    if (targetEnabled) {
      let best: Awaited<ReturnType<typeof render>> | null = null;
      let bestQuality = 0;
      let smallest: Awaited<ReturnType<typeof render>> | null = null;
      const found = await searchTargetSize(o.targetBytes!, o.quality, async (candidateQuality) => {
        const candidate = await render(candidateQuality);
        if (!smallest || candidate.blob.size < smallest.blob.size) smallest = candidate;
        if (candidate.blob.size <= o.targetBytes! && (!best || candidateQuality > bestQuality)) {
          best = candidate;
          bestQuality = candidateQuality;
        }
        await (o.yieldBetweenTiles ?? yieldForInput)();
        return candidate.blob.size;
      }, { signal: o.signal, onAttempt: (attempts) => o.onProgress?.(attempts / MAX_TARGET_ATTEMPTS * 0.95) });
      main = best ?? smallest;
      if (!main) throw new EncodeError("ENCODE_MEMORY_PRESSURE", "target search did not encode");
      quality = found.quality;
      target = { bytes: o.targetBytes!, metTarget: found.metTarget, attempts: found.attempts };
    } else {
      main = await renderDecoded(bitmap, transform, {
        ...common,
        format: o.format,
        quality: encoderQuality(o.format, o.quality),
        onProgress: (p) => o.onProgress?.(o.probe ? p * 0.8 : p),
      });
      await verifyEncoded(main.blob, o.format, expected);
    }
    let probe: EncodeResult["probe"];
    const probeFormat = o.probe?.format;
    if (!targetEnabled && o.probe && probeFormat && probeFormat !== o.format && o.source.width * o.source.height <= PROBE_MAX_PIXELS && !encodeIssue(o.source, probeFormat, typeof CompressionStream !== "undefined", o.resizePercent)) {
      // Best effort: a failed probe only means no size hint.
      const alt = await (async () => {
        const output = await renderDecoded(bitmap, transform, { ...common, format: probeFormat, quality: encoderQuality(probeFormat, o.probe!.quality) });
        await verifyEncoded(output.blob, probeFormat, expected);
        return output;
      })().catch(() => null);
      if (alt) probe = { format: probeFormat, quality: o.probe.quality, bytes: alt.blob.size };
    }
    if (o.signal?.aborted) throw new EncodeError("ENCODE_CANCELLED");
    o.onProgress?.(1);
    return { blob: main.blob, width: main.width, height: main.height, format: o.format, strategy: main.strategy, ms: Math.round(performance.now() - started), quality, target, probe };
  } catch (error) {
    throw toEncodeError(error);
  } finally {
    bitmap?.close();
  }
}

/**
 * Encode PNG/JPEG/WebP from one decoded source. Candidates are created sequentially so only one
 * render canvas is live at a time. The caller owns the returned Blobs and should drop unselected
 * candidates when the comparison is replaced or the tool unmounts.
 */
export async function compareFormats(
  image: Blob,
  o: Omit<EncodeOptions, "format" | "probe" | "targetBytes"> & { formats?: readonly OutputFormat[]; existing?: readonly FormatCandidate[] },
): Promise<FormatComparisonResult> {
  if (o.source.width * o.source.height > FORMAT_COMPARE_MAX_PIXELS) throw new EncodeError("ENCODE_TOO_LARGE", "format comparison is limited to 16 MP");
  const formats = o.formats ?? OUTPUT_FORMATS;
  for (const format of formats) assertEncodable(o.source, format, typeof CompressionStream !== "undefined", o.resizePercent);
  const started = performance.now();
  let bitmap: ImageBitmap | null = null;
  try {
    // Checked before every Blob read: a read started while the page is being left is refused.
    if (o.signal?.aborted) throw new EncodeError("ENCODE_CANCELLED");
    const expected = encodeSize(o.source, o.resizePercent);
    const transform = transformFor(o);
    const candidates = [] as FormatComparisonResult["candidates"];
    for (let index = 0; index < formats.length; index++) {
      if (o.signal?.aborted) throw new EncodeError("ENCODE_CANCELLED");
      const format = formats[index];
      const existing = o.existing?.find((candidate) => candidate.format === format && candidate.width === expected.width && candidate.height === expected.height && (format === "png" || candidate.quality === o.quality));
      if (existing) {
        await verifyEncoded(existing.blob, format, expected);
        candidates.push(existing);
        o.onProgress?.((index + 1) / formats.length);
        continue;
      }
      bitmap ??= await decodeSource(image, o.source);
      const rendered = await renderDecoded(bitmap, transform, {
        source: o.source,
        background: o.background,
        format,
        quality: encoderQuality(format, o.quality),
        createCanvas: o.createCanvas,
        yieldBetweenTiles: o.yieldBetweenTiles,
        signal: o.signal,
        onProgress: (progress) => o.onProgress?.((index + progress) / formats.length),
      });
      await verifyEncoded(rendered.blob, format, expected);
      candidates.push({ blob: rendered.blob, bytes: rendered.blob.size, width: rendered.width, height: rendered.height, format, quality: o.quality, strategy: rendered.strategy });
      await (o.yieldBetweenTiles ?? yieldForInput)();
    }
    if (o.signal?.aborted) throw new EncodeError("ENCODE_CANCELLED");
    o.onProgress?.(1);
    return { candidates, ms: Math.round(performance.now() - started) };
  } catch (error) {
    throw toEncodeError(error);
  } finally {
    bitmap?.close();
  }
}
