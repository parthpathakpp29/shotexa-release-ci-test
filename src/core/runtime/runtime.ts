/**
 * WorkspaceRuntime (architecture §22): Zustand store + AssetRegistry + WorkerBroker +
 * capabilities, and the operations that span them (ingest, previews, overlap hint, Smart
 * Stitch analysis/export, artifacts). Created once per WorkspaceProvider mount — screenshots
 * are never persisted; a full reload starts empty.
 */
import { toast } from "@/components/ui/use-toast";
import { encodeCanvas } from "@/core/image-encode/encode";
import { readImageSize } from "@/core/image/image-size";
import { createBoundedPreview, PreviewError } from "@/core/image/preview";
import { PREVIEW_LIMITS, previewSize, validImageSize } from "@/core/image/preview-size";
import { softBudgetFor } from "@/config/limits";
import { validateImageHeader } from "@/core/image/validate";
import type { MetadataCleanRun, MetadataInspectRun } from "@/core/metadata/run";
import { DEFAULT_OCR_CONFIG } from "@/config/ocr";
import type { OcrService } from "@/core/ocr/ocr-service";
import type { OcrResult } from "@/core/ocr/types";
import { hasOcrText } from "@/core/ocr/normalize";
import type { AnalysedSet, ShotexaPdfEngine } from "@/core/pdf/pdf-engine";
import type { PageSetup, PaginationPlan } from "@/core/pdf/types";
import { searchableSourceFromResult } from "@/core/pdf/searchable-text";
import type { CombinePlan } from "@/core/combine/types";
import type { CompareAlignEstimate, CompareTextDiff, CompareVisualAnalysis } from "@/core/compare/types";
import { EncodeError, type EncodeTool, type FormatCandidate } from "@/core/image-encode/types";
import { EncodeSession } from "@/core/image-encode/session";
import { encodeRequestKey, encodedName, formatComparisonKey, resolveFormat } from "@/core/image-encode/settings";
import { encodeSize, resizePercent } from "@/core/image-encode/geometry";
import { FORMAT_MIME, OUTPUT_FORMATS } from "@/core/image-encode/formats";
import type { OutputFormat } from "@/core/image-encode/formats";
import { IDENTITY_TRANSFORM, isIdentity } from "@/core/image-transform/transform";
import { RedactionError, type SafeShareExportResult, type SafeShareVerification } from "@/core/redaction/types";
import { isSafeShareVerified } from "@/core/redaction/verification";
import { PrivacyScanRegistry } from "@/core/privacy/registry";
import type { PrivacyScanConfig, PrivacyScanResult } from "@/core/privacy/types";
import { StructuredResultRegistry } from "@/core/structured-data/registry";
import type { StructuredAnalysisOptions, StructuredExtraction } from "@/core/structured-data/types";
import { planStitchChain, type ChainPlan } from "@/core/stitch/chain";
import { rgbaToGray } from "@/core/stitch/gray";
import { HINT, likelyOverlap } from "@/core/stitch/overlap-hint";
import type { GrayImage } from "@/core/stitch/types";
import { WorkerJobError } from "@/workers/broker/worker-client";
import { CompareAnalysisRegistry, compareAlignKey, comparePairKey, type CompareReportKind } from "./compare-analysis-registry";
import { AssetRegistry } from "./asset-registry";
import { safeFileName } from "./safe-name";
import { OcrResultRegistry } from "./ocr-result-registry";
import { PdfAnalysisRegistry } from "./pdf-analysis-registry";
import { BatchResultRegistry } from "./batch-result-registry";
import { BackgroundMaskRegistry } from "@/core/background-removal/registry";
import { DEFAULT_BACKGROUND_REMOVAL, type BackgroundRemovalRenderResult, type BackgroundRemovalSettings, type SegmentationResult } from "@/core/background-removal/types";
import type { BatchResult, BatchSource } from "@/core/batch/types";
import { MAX_BATCH_FILES, MAX_BATCH_INPUT_BYTES } from "@/core/batch/types";
import { batchFormat, batchOutputName, resizeOutput, resultMime } from "@/core/batch/settings";
import { uniqueOutputNames, withAffixes } from "@/core/batch/naming";
import { runSequential } from "@/core/batch/runner";
import { detectCapabilities, timeSlicer, type Capabilities } from "./capabilities";
import { createWorkspaceStore, pairKey, selectJoinKeys, selectOriginals, type WorkspaceStore } from "./store";
import { ocrLanguages, type FileId, type FileSource, type ImageMime, type Job, type OcrLanguageChoice, type PdfBreakEdit, type StitchPair, type WorkspaceDocument, type WorkspaceFile } from "./types";
import { browserWorkerFactories, WorkerBroker } from "./worker-broker";

export const PREVIEW = PREVIEW_LIMITS;

export interface IngestOptions {
  /** Default waits for previews for existing workflows/API callers; shared picker acknowledges early. */
  waitForPreviews?: boolean;
  signal?: AbortSignal;
}

export interface IngestResult {
  added: FileId[];
  rejected: { name: string; code: string }[];
}

export interface StitchExportResult {
  id: FileId;
  width: number;
  height: number;
  bytes: number;
}

export type CombineExportResult = StitchExportResult;

export interface EditorExportResult extends StitchExportResult {
  /** The unchanged asset the edit was made from. */
  sourceId: FileId;
}

export interface WorkspaceSafeShareResult extends Omit<SafeShareExportResult, "blob"> {
  id: FileId;
  bytes: number;
}

export interface WorkspaceMetadataCleanResult extends MetadataCleanRun {
  artifactId: FileId | null;
}

export interface WorkspaceOcrResult {
  resultId: string;
  result: OcrResult;
}

/** One rendered Split piece, held by the page until the user downloads it or adds it to the workspace. */
export interface SplitRunPiece {
  name: string;
  type: ImageMime;
  blob: Blob;
  width: number;
  height: number;
  bytes: number;
  /** Source rows [y0, y1). */
  y0: number;
  y1: number;
}

export interface SplitRunResult {
  sourceId: FileId;
  pieces: SplitRunPiece[];
  strategy: "single-canvas" | "tiled-png";
  ms: number;
}

/** A Compress / Convert run, held by the page until the user saves it. */
export interface EncodeRunResult {
  tool: EncodeTool;
  sourceId: FileId;
  name: string;
  type: ImageMime;
  blob: Blob;
  width: number;
  height: number;
  bytes: number;
  /** Size of the source file, for the comparison. */
  originalBytes: number;
  format: OutputFormat;
  quality: number;
  background: string;
  requestedQuality?: number;
  resizePercent?: number;
  ms: number;
  target?: { bytes: number; metTarget: boolean; attempts: number };
  probe?: { format: OutputFormat; quality: number; bytes: number };
}

export interface FormatComparisonRun {
  sourceId: FileId;
  candidates: EncodeRunResult[];
  ms: number;
}

export interface WorkspacePdfResult {
  id: string;
  blob: Blob;
  bytes: number;
  pages: number;
  ms: number;
  path: "worker" | "main-thread";
}

const EXT: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
/** Worker preview failures the page must not retry itself (see `makePreview`). */
const NO_PAGE_FALLBACK = new Set(["WORKER_CRASHED", "CANCELLED", "DECODE_FAILED", "PREVIEW_TOO_LARGE", "PREVIEW_MEMORY_PRESSURE"]);
const codeOf = (e: unknown) => (e instanceof WorkerJobError ? e.code : ((e as { code?: string })?.code ?? "INTERNAL"));
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `f${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

export interface WorkspaceRuntime {
  store: WorkspaceStore;
  registry: AssetRegistry;
  ocrResults: OcrResultRegistry;
  structuredResults: StructuredResultRegistry;
  privacyScans: PrivacyScanRegistry;
  pdfAnalyses: PdfAnalysisRegistry;
  batchResults: BatchResultRegistry;
  backgroundMasks: BackgroundMaskRegistry;
  compareAnalyses: CompareAnalysisRegistry;
  broker: WorkerBroker;
  caps: Capabilities;
  ingest(files: File[], source: FileSource, options?: IngestOptions): Promise<IngestResult>;
  cancelPreviews(): void;
  retryPreviews(): Promise<void>;
  /** Validated local image for branding; it does not become a screenshot. */
  ingestResource(file: File): Promise<IngestResult>;
  removeFile(id: FileId): void;
  clear(): void;
  analyseStitch(options?: { force?: boolean }): Promise<void>;
  cancelStitch(): void;
  stitchPlan(): ChainPlan | null;
  exportStitch(): Promise<StitchExportResult>;
  exportCombine(inputIds: FileId[], plan: CombinePlan): Promise<CombineExportResult>;
  /** Render the asset's editor transform at full resolution into a new workspace artifact. */
  exportEdit(assetId?: FileId): Promise<EditorExportResult>;
  /** Flatten the asset's annotations (on top of any pending editor transform) into a new artifact. */
  exportAnnotated(assetId?: FileId): Promise<EditorExportResult>;
  /**
   * Render the asset's split at full resolution. The pieces are returned, NOT added to the
   * workspace: a long screenshot can make dozens, so adding them is an explicit second step.
   */
  exportSplit(assetId?: FileId): Promise<SplitRunResult>;
  /** Add rendered Split pieces to the workspace as artifacts (the first is selected). */
  addSplitPieces(result: SplitRunResult): FileId[];
  /**
   * Render the current comparison of the two chosen screenshots at full resolution into a new
   * artifact that records BOTH parents.
   */
  exportCompare(): Promise<EditorExportResult>;
  cancelCompareExport(): void;
  /**
   * Measure how to put "after" on top of "before" for the current comparison, from small
   * greyscale proxies of the preview bitmaps. Cached until the chosen screenshots or the
   * fitting change, so moving a slider never re-measures anything.
   */
  alignCompare(force?: boolean): Promise<CompareAlignEstimate>;
  /** Forget the measured alignment (the manual nudge is settings, and is reset separately). */
  resetCompareAlignment(): void;
  /**
   * OCR both screenshots (reusing any cached result) and diff the visible text. Never runs
   * as part of the visual comparison: it is always an explicit, cancellable request.
   */
  analyseCompareText(onStage?: (stage: string) => void): Promise<CompareTextDiff>;
  cancelCompareText(): Promise<void>;
  /** Publish the preview's measurement so the summary, report and workflows can read it. */
  publishCompareAnalysis(analysis: CompareVisualAnalysis | null): void;
  /**
   * Measure the comparison without a preview on screen, at a bounded analysis width. Used by
   * the report and by the workflow adapter so neither depends on the user having opened the
   * Difference view — and so neither needs its own copy of the comparison logic.
   */
  measureCompare(maxWidth?: number): Promise<CompareVisualAnalysis | null>;
  /** Build the Shotexa Visual Comparison Report. Returns the Blob; nothing is uploaded. */
  exportCompareReport(kind: CompareReportKind, options?: { download?: boolean }): Promise<{ blob: Blob; name: string }>;
  /** Compose the asset with its Beautifier settings at full resolution into a new artifact. */
  exportBeautified(assetId?: FileId): Promise<EditorExportResult>;
  /**
   * Compress / Convert: re-encode with the tool's settings (original size unless resized). The
   * result is returned for comparison, not added — `saveEncoded` makes it an artifact.
   */
  encodeAsset(tool: EncodeTool, assetId?: FileId, options?: { signal?: AbortSignal; measureAlternative?: boolean }): Promise<EncodeRunResult>;
  /** Measure PNG/JPEG/WebP from one bounded decode. Results are unsaved until selected. */
  compareEncodeFormats(assetId?: FileId, tool?: EncodeTool, options?: { signal?: AbortSignal }): Promise<FormatComparisonRun>;
  cancelEncode(): void;
  /** Add an encoded result to the workspace as a new, selected artifact. */
  saveEncoded(result: EncodeRunResult): FileId;
  /** Whether the asset has transparent pixels (checked on its preview); null until known. */
  hasTransparency(assetId: FileId): Promise<boolean | null>;
  exportSafeShare(assetId?: FileId): Promise<WorkspaceSafeShareResult>;
  prepareSafeShare(assetId?: FileId): Promise<WorkspaceSafeShareResult>;
  extractPreparedSafeShareText(id: FileId): Promise<OcrResult>;
  publishPreparedSafeShare(id: FileId): FileId;
  discardPreparedSafeShare(id: FileId): void;
  inspectMetadata(assetId?: FileId): Promise<MetadataInspectRun>;
  cleanMetadata(assetId?: FileId): Promise<WorkspaceMetadataCleanResult>;
  extractText(assetId?: FileId, language?: OcrLanguageChoice, silent?: boolean): Promise<WorkspaceOcrResult>;
  cancelOcr(assetId?: FileId, silent?: boolean): Promise<void>;
  extractStructuredData(assetId: FileId, options?: StructuredAnalysisOptions, onStage?: (stage: string) => void): Promise<StructuredExtraction>;
  cancelStructuredData(): void;
  scanPrivacy(assetId: FileId, config: PrivacyScanConfig, onStage?: (stage: string) => void): Promise<PrivacyScanResult>;
  cancelPrivacyScan(): Promise<void>;
  removeBackground(assetId: FileId, onStage?: (stage: string) => void, silent?: boolean, method?: "object" | "ink"): Promise<SegmentationResult>;
  cancelBackgroundRemoval(): void;
  exportRemovedBackground(assetId: FileId, settings?: BackgroundRemovalSettings, backgroundImage?: Blob): Promise<EditorExportResult>;
  planPdf(inputIds: FileId[], setup: PageSetup, smart: boolean, edits?: Record<FileId, PdfBreakEdit>): Promise<PaginationPlan>;
  pdfSafeYs(assetId: FileId): number[];
  exportPdf(inputIds: FileId[], plan: PaginationPlan): Promise<WorkspacePdfResult>;
  exportSearchablePdf(inputIds: FileId[], plan: PaginationPlan): Promise<WorkspacePdfResult>;
  cancelPdf(): void;
  runBatch(ids?: FileId[]): Promise<{ completed: number; failed: number; cancelled: number }>;
  cancelBatch(): void;
  resetBatch(): void;
  retryBatchFailed(): Promise<{ completed: number; failed: number; cancelled: number }>;
  createBatchZip(): Promise<{ blob: Blob; names: string[] }>;
  addBatchResults(): FileId[];
  addConvertedImage(blob: Blob, name: string, width: number, height: number, producedBy: "pdf-to-jpg" | "svg-to-png"): FileId;
  dispose(): void;
}

export function createWorkspaceRuntime(opts: {
  broker?: WorkerBroker;
  caps?: Capabilities;
  createOcrService?: () => Promise<OcrService>;
  ocrTimeoutMs?: number;
  /** Where `pagehide`/`pageshow` arrive (the window by default; tests pass their own target). */
  pageEvents?: EventTarget | null;
} = {}): WorkspaceRuntime {
  const registry = new AssetRegistry();
  const encodeSession = new EncodeSession();
  let encodeJobSequence = 0;
  const pendingSafeShares = new Map<FileId, { sourceId: FileId; blob: Blob; width: number; height: number; mime: ImageMime; producedBy: "safe-share" | "blur"; verification: Readonly<SafeShareVerification> }>();
  const ocrResults = new OcrResultRegistry();
  const structuredResults = new StructuredResultRegistry();
  const privacyScans = new PrivacyScanRegistry();
  const pdfAnalyses = new PdfAnalysisRegistry();
  const batchResults = new BatchResultRegistry();
  const backgroundMasks = new BackgroundMaskRegistry();
  const compareAnalyses = new CompareAnalysisRegistry();
  const store = createWorkspaceStore((id) => {
    previewRequests.get(id)?.abort.abort();
    encodeSession.forget(registry.blob(id));
    registry.remove(id);
    for (const [pendingId, pending] of pendingSafeShares) if (pending.sourceId === id) {
      registry.remove(pendingId);
      pendingSafeShares.delete(pendingId);
    }
    ocrResults.removeAsset(id);
    structuredResults.removeAsset(id);
    privacyScans.removeAsset(id);
    pdfAnalyses.remove(id);
    batchResults.removeSource(id);
    backgroundMasks.remove(id);
    compareAnalyses.removeAsset(id);
    alphaCache.delete(id);
  });
  const broker = opts.broker ?? new WorkerBroker(browserWorkerFactories());
  const caps = opts.caps ?? detectCapabilities();
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const previewBudget = softBudgetFor({ deviceMemoryGiB: (nav as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory, isIOS: /iPad|iPhone|iPod/.test(nav?.userAgent ?? "") || (nav?.platform === "MacIntel" && (nav?.maxTouchPoints ?? 0) > 1) });
  const proxies = new Map<FileId, GrayImage>();
  /** Transparency found on each asset's preview (Compress/Convert); dropped with the asset. */
  const alphaCache = new Map<FileId, boolean>();
  let pasteCount = 0;
  let activeBatchAbort: AbortController | null = null;
  let activePrivacyAbort: AbortController | null = null;
  let previewChain: Promise<void> = Promise.resolve();
  const previewRequests = new Map<FileId, { blob: Blob; abort: AbortController; promise: Promise<void> }>();
  let ingestTail: Promise<void> = Promise.resolve();
  let inputGeneration = 0;
  let disposed = false;
  /**
   * The page is being left — a navigation, a closed tab, or a move into the back/forward
   * cache. WebKit stops a page's loads as soon as a navigation starts (before `pagehide`), so
   * a decode or Blob read started from then on is refused and reported as a page error
   * ("Cannot load blob … due to access control checks"). Image work therefore starts nothing
   * new while leaving: previews stop, worker jobs are refused, and main-thread pipelines stop
   * between steps through `pageAbort`. Work already running finishes or is cancelled quietly.
   */
  let leaving = false;
  let pageAbort = new AbortController();
  let ocrService: OcrService | null = null;
  let ocrServiceLoading: Promise<OcrService> | null = null;
  let activeOcrAsset: FileId | null = null;
  let activeOcrAbort: AbortController | null = null;
  let ocrRequestRevision = 0;
  let activeStructuredAbort: AbortController | null = null;
  let activeBackgroundAbort: AbortController | null = null;
  let activeCompareTextAbort: AbortController | null = null;
  let activeCompareReportAbort: AbortController | null = null;
  let activeCompareExportAbort: AbortController | null = null;
  let activeStitchAnalysisAbort: AbortController | null = null;
  let activeStitchExportAbort: AbortController | null = null;
  let stitchAnalysisRun: Promise<void> | null = null;
  let stitchAnalysisSignature = "";
  let pdfEngine: ShotexaPdfEngine | null = null;
  let activePdfAbort: AbortController | null = null;

  const getOcrService = async () => {
    if (ocrService) return ocrService;
    if (!ocrServiceLoading) {
      ocrServiceLoading = (opts.createOcrService
        ? opts.createOcrService()
        : import("@/core/ocr/ocr-service").then((module) => module.createOcrService()))
        .then(async (service) => {
          if (disposed) { await service.dispose(); throw Object.assign(new Error("OCR_CANCELLED"), { code: "OCR_CANCELLED" }); }
          ocrService = service;
          return service;
        }).finally(() => { ocrServiceLoading = null; });
    }
    return ocrServiceLoading;
  };

  const getPdfEngine = async () => {
    if (pdfEngine) return pdfEngine;
    const { createPdfEngine } = await import("@/core/pdf/pdf-engine");
    // Spike D: 10% upward search plus at most 5% page shrink had the best equal-page-count result.
    pdfEngine = createPdfEngine({ windowUp: 0.1, windowDown: 0.05 });
    return pdfEngine;
  };

  const job = (id: string, kind: Job["kind"], status: Job["status"], progress: number | null = null, error?: string) =>
    store.getState().upsertJob({ id, kind, status, progress, error });

  /** One serial preview queue. Reuse queued/cached work; every request owns its Blob and signal. */
  function makePreview(id: FileId): Promise<void> {
    const blob = registry.blob(id);
    if (!blob || disposed || leaving || registry.preview(id)) return Promise.resolve();
    const existing = previewRequests.get(id);
    if (existing?.blob === blob && !existing.abort.signal.aborted) return existing.promise;
    existing?.abort.abort();
    const abort = new AbortController();
    const request = { blob, abort, promise: Promise.resolve() };
    previewRequests.set(id, request);
    job(`preview:${id}`, "preview", "running", 0);
    const current = () => !disposed && previewRequests.get(id) === request && registry.blob(id) === blob && !!store.getState().files[id];
    request.promise = track(() => previewChain.then(async () => {
      if (!current() || abort.signal.aborted || leaving) return;
      // Header validation/store updates get a paint/input opportunity before native decoding.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (!current() || abort.signal.aborted || leaving) return;
      await makePreviewNow(id, blob, abort.signal);
    })).then(() => {
      if (current()) job(`preview:${id}`, "preview", abort.signal.aborted || !registry.preview(id) ? "cancelled" : "done", registry.preview(id) ? 1 : null);
    }).catch((error) => {
      const cancelled = abort.signal.aborted || codeOf(error) === "CANCELLED";
      const code = codeOf(error);
      if (current()) job(`preview:${id}`, "preview", cancelled ? "cancelled" : "failed", null, cancelled ? "CANCELLED" : code === "PREVIEW_TOO_LARGE" || code === "PREVIEW_MEMORY_PRESSURE" ? code : "DECODE_FAILED");
    }).finally(() => { if (previewRequests.get(id) === request) previewRequests.delete(id); });
    previewChain = request.promise;
    return request.promise;
  }

  function cancelPreviews() {
    for (const [id, request] of previewRequests) {
      request.abort.abort();
      if (store.getState().files[id]) job(`preview:${id}`, "preview", "cancelled");
    }
  }

  async function makePreviewNow(id: FileId, blob: Blob, signal: AbortSignal) {
    if (disposed || leaving || signal.aborted) return;
    const file = store.getState().files[id];
    if (!file) return;
    const target = previewSize(file);
    const estimated = (file.width * file.height + target.width * target.height) * 4;
    if (estimated > previewBudget) throw new PreviewError("PREVIEW_TOO_LARGE");
    const remainingBudget = previewBudget - registry.previewMemory().bytes;
    // Resident previews count too. Stop background decoding before another source exceeds the
    // existing device-aware soft budget; keep every original for removal, retry or explicit tools.
    if (estimated > remainingBudget) throw new PreviewError("PREVIEW_MEMORY_PRESSURE");
    let bitmap: ImageBitmap;
    let displaySize: { width: number; height: number } | undefined;
    try {
      const preview = await broker.run("image", "image.preview", { image: blob, ...PREVIEW, budgetBytes: remainingBudget }, { signal });
      bitmap = preview.bitmap;
      displaySize = { width: preview.width, height: preview.height };
    } catch (error) {
      // Decode on the page only when the worker ran and could not do something the page can.
      // Never after the page starts going away (see `leaving`), and never because the worker
      // itself failed or was stopped: WebKit stops a page's loads as soon as a navigation
      // starts — before `pagehide` — which kills a worker still loading its script, and a
      // decode started then is refused ("Cannot load blob … due to access control checks").
      // A crashed worker (or one out of memory) is no better served by the same decode on the
      // main thread, and a failed decode would fail identically there.
      if (disposed || leaving || signal.aborted || registry.blob(id) !== blob) return;
      if (NO_PAGE_FALLBACK.has(codeOf(error))) throw error;
      if (!store.getState().files[id]) return;
      const preview = await createBoundedPreview(blob, { ...PREVIEW, budgetBytes: remainingBudget, signal });
      bitmap = preview.bitmap;
      displaySize = { width: preview.width, height: preview.height };
    }
    if (disposed || signal.aborted || registry.blob(id) !== blob || !store.getState().files[id]) {
      bitmap.close();
      return;
    }
    registry.setPreview(id, bitmap);
    proxies.delete(id);
    store.getState().markPreview(id, displaySize);
  }

  /** After a back/forward-cache restore: previews interrupted by `pagehide` are made now. */
  function resumePreviews() {
    for (const id of Object.keys(store.getState().files)) {
      if (registry.preview(id)) continue;
      void makePreview(id);
    }
  }

  const pageEvents = opts.pageEvents === undefined ? (typeof window === "undefined" ? null : window) : opts.pageEvents;
  function markLeaving() {
    if (leaving) return;
    leaving = true;
    cancelPreviews();
    encodeSession.cancel();
    cancelStitch();
    cancelCompareExport();
    activeCompareReportAbort?.abort();
    broker.suspend?.();
    pageAbort.abort();
  }
  function markStaying() {
    if (!leaving || disposed) return;
    leaving = false;
    pageAbort = new AbortController();
    broker.resume?.();
    resumePreviews();
  }
  const onPageHide = () => markLeaving();
  // Only a page restored from the back/forward cache comes back; a fresh load is a new runtime.
  const onPageShow = (event: Event) => { if ((event as PageTransitionEvent).persisted) markStaying(); };
  // `beforeunload` is the first sign of a navigation — early enough to stop new loads. If the
  // navigation does not happen after all (cancelled, or it became a download), the page is
  // still in use: the next interaction resumes the work.
  const onStillHere = () => markStaying();
  const onBeforeUnload = () => {
    markLeaving();
    pageEvents?.addEventListener("pointerdown", onStillHere, { once: true });
    pageEvents?.addEventListener("keydown", onStillHere, { once: true });
  };
  pageEvents?.addEventListener("pagehide", onPageHide);
  pageEvents?.addEventListener("pageshow", onPageShow);
  /**
   * Queued or running image work. A `beforeunload` listener can keep a page out of Firefox's
   * back/forward cache, so it is attached only while such work runs (web.dev guidance).
   */
  let busy = 0;
  async function track<T>(work: () => Promise<T>): Promise<T> {
    if (busy++ === 0) pageEvents?.addEventListener("beforeunload", onBeforeUnload);
    try {
      return await work();
    } finally {
      if (--busy === 0) pageEvents?.removeEventListener("beforeunload", onBeforeUnload);
    }
  }

  /** Tiny greyscale proxy (for the overlap hint) from the preview bitmap. */
  function proxyOf(id: FileId): GrayImage | null {
    const cached = proxies.get(id);
    if (cached) return cached;
    const bm = registry.preview(id);
    if (!bm) return null;
    const { width: w, height: h } = previewSize(bm, { maxWidth: Math.min(HINT.width, bm.width), maxPixels: 65536, maxHeight: 2048 });
    const canvas: OffscreenCanvas | HTMLCanvasElement = caps.offscreenCanvas ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(bm, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    canvas.width = 0;
    const data = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < data.length; i++, p += 4) data[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    const g = { width: w, height: h, data };
    proxies.set(id, g);
    return g;
  }

  /**
   * Full-resolution greyscale decoded on the page, for browsers whose workers can't read
   * pixels (no OffscreenCanvas — WebKit/WinCairo, Spike B). 1 byte per pixel is transferred.
   */
  function pageGray(blob: Blob): Promise<GrayImage> {
    return track(() => pageGrayNow(blob));
  }

  async function pageGrayNow(blob: Blob): Promise<GrayImage> {
    // Never start a decode on a page that is being left (see `leaving`).
    if (disposed || leaving) throw Object.assign(new Error("Page is closing"), { code: "CANCELLED" });
    const bm = await createImageBitmap(blob);
    const canvas = Object.assign(document.createElement("canvas"), { width: bm.width, height: bm.height });
    try {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw Object.assign(new Error("canvas"), { code: "MEMORY_PRESSURE" });
      ctx.drawImage(bm, 0, 0);
      return rgbaToGray(ctx.getImageData(0, 0, bm.width, bm.height).data, bm.width, bm.height);
    } finally {
      bm.close();
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  async function checkOverlap() {
    const s = store.getState();
    const current = () => !disposed && store.getState().order === s.order;
    const originals = selectOriginals(s);
    if (originals.length < 2 || s.overlapHint.dismissed || s.overlapHint.status !== "idle") return;
    if (originals.some((f) => !registry.preview(f.id))) return; // wait for previews
    store.getState().setOverlapHint({ status: "checking" });
    if (!current()) return;
    job("overlap", "overlap-check", "running");
    const likely: string[] = [];
    try {
    for (let i = 0; i + 1 < originals.length; i++) {
      if (!current()) return;
      const a = proxyOf(originals[i].id);
      const b = proxyOf(originals[i + 1].id);
      if (a && b && likelyOverlap(a, b).likely) likely.push(pairKey(originals[i].id, originals[i + 1].id));
      await new Promise((r) => setTimeout(r, 0));
    }
    if (!current()) return;
    store.getState().setOverlapHint({ status: likely.length ? "likely" : "unlikely", pairs: likely });
    job("overlap", "overlap-check", "done");
    } catch {
      // This optional suggestion must never turn a successful file load/retry into a rejection.
      if (current()) {
        store.getState().setOverlapHint({ status: "idle", pairs: [] });
        job("overlap", "overlap-check", "failed", null, "MEMORY_PRESSURE");
      }
    }
  }

  async function ingest(files: File[], source: FileSource, options: IngestOptions = {}, asResource = false): Promise<IngestResult> {
    const generation = inputGeneration;
    const accepted = track(() => ingestTail.then(() => acceptFiles(files, source, asResource, options.signal, generation)));
    ingestTail = accepted.then(() => undefined, () => undefined);
    const { result, ready } = await accepted;
    if (options.waitForPreviews !== false) await ready;
    return result;
  }

  async function acceptFiles(files: File[], source: FileSource, asResource: boolean, signal: AbortSignal | undefined, generation: number) {
    const rejected: IngestResult["rejected"] = [];
    const metas: WorkspaceFile[] = [];
    const blobs: Blob[] = [];
    const stopped = () => disposed || leaving || signal?.aborted || generation !== inputGeneration;
    for (const file of files) {
      if (stopped()) break;
      // Reading a file can fail: it was moved or deleted, or the page is being left and WebKit
      // has already stopped file reads (NotReadableError). Neither may escape as an error.
      let head: Uint8Array;
      let size: Awaited<ReturnType<typeof readImageSize>>;
      try {
        head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      } catch {
        if (stopped()) break;
        rejected.push({ name: file.name || "Pasted image", code: "UNREADABLE" });
        continue;
      }
      const v = validateImageHeader(file.name, file.type, head); // extension + MIME + magic bytes
      if (!v.ok) {
        rejected.push({ name: file.name || "Pasted image", code: v.code });
        continue;
      }
      try {
        size = await readImageSize(file, signal); // bounded headers only — no decode
      } catch {
        if (stopped()) break;
        size = null;
      }
      if (stopped()) break;
      if (!size || !validImageSize(size)) {
        rejected.push({ name: file.name || "Pasted image", code: "UNREADABLE" });
        continue;
      }
      const id = newId();
      // Sanitised once, here: the name reaches download attributes and ZIP entries later.
      const name = source === "paste" || !file.name ? `Pasted screenshot ${++pasteCount}.${EXT[v.type]}` : safeFileName(file.name, `screenshot.${EXT[v.type]}`);
      blobs.push(file);
      metas.push({ id, name, type: v.type, bytes: file.size, width: size.width, height: size.height, source, kind: asResource ? "resource" : "original", addedAt: Date.now(), previewVersion: 0 });
      if (metas.length % 8 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (stopped()) return { result: { added: [], rejected }, ready: Promise.resolve() };
    // WorkspaceProvider already presents one concise, aria-live ingestion summary. Keep
    // that established notice as the sole file-add/rejection announcement rather than
    // showing a second toast for the same action.
    if (metas.length) {
      metas.forEach((meta, index) => registry.put(meta.id, blobs[index]));
      if (asResource) store.getState().addResources(metas);
      else store.getState().addFiles(metas);
    }
    const previews = metas.map((m) => makePreview(m.id));
    const onAbort = () => { for (const meta of metas) previewRequests.get(meta.id)?.abort.abort(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const ready = Promise.all(previews).then(async () => {
      if (!asResource && !stopped()) await checkOverlap();
    }).catch(() => undefined).finally(() => signal?.removeEventListener("abort", onAbort));
    return { result: { added: metas.map((m) => m.id), rejected }, ready };
  }

  function cancelStitch() {
    if (activeStitchAnalysisAbort) {
      activeStitchAnalysisAbort.abort();
      // Native matching and script/WASM loading cannot receive CANCEL until they
      // yield. Vision is the dedicated stitching family, so release it promptly.
      broker.release("vision");
    }
    activeStitchExportAbort?.abort();
  }

  async function analyseStitch(options: { force?: boolean } = {}) {
    const keys = selectJoinKeys(store.getState());
    const signature = keys.join(",");
    if (stitchAnalysisRun && !options.force && !activeStitchAnalysisAbort?.signal.aborted && stitchAnalysisSignature === signature) return stitchAnalysisRun;
    if (activeStitchAnalysisAbort) { activeStitchAnalysisAbort.abort(); broker.release("vision"); }
    const abort = new AbortController();
    activeStitchAnalysisAbort = abort;
    stitchAnalysisSignature = signature;
    stitchAnalysisRun = (async () => { await Promise.resolve(); try {
    for (const [i, key] of keys.entries()) {
      if (abort.signal.aborted || disposed || activeStitchAnalysisAbort !== abort) break;
      const s = store.getState();
      const existing = s.stitch.pairs[key];
      if (!options.force && existing?.status === "ready") continue;
      const [a, b] = key.split("|");
      const blobA = registry.blob(a), blobB = registry.blob(b);
      if (!s.files[a] || !s.files[b] || !blobA || !blobB) break;
      const owns = () => activeStitchAnalysisAbort === abort && !disposed;
      const inputsPresent = () => registry.blob(a) === blobA && registry.blob(b) === blobB && selectJoinKeys(store.getState()).includes(key);
      const base: StitchPair = { key, a, b, status: "analysing", autoOffset: s.files[a].height, offset: s.files[a].height, confidence: "low", matched: false, bands: { top: 0, bottom: 0 } };
      s.setPair(base);
      job(`analyse:${key}`, "stitch-analyse", "running", i / keys.length);
      try {
        const { stitchAnalysisIssue } = await import("@/core/stitch/limits");
        if (stitchAnalysisIssue(s.files[a], s.files[b], caps.offscreenCanvas)) throw Object.assign(new Error("Stitch analysis exceeds supported memory/canvas limits"), { code: "MEMORY_PRESSURE" });
        if (abort.signal.aborted) throw Object.assign(new Error("CANCELLED"), { code: "CANCELLED" });
        const r = caps.offscreenCanvas
          ? await broker.run("vision", "stitch.analyse", { a: blobA, b: blobB }, { signal: abort.signal })
          : await broker.run("vision", "stitch.analyseGray", { a: await pageGray(blobA), b: await pageGray(blobB) }, { signal: abort.signal });
        if (abort.signal.aborted || !owns() || !inputsPresent()) throw Object.assign(new Error("CANCELLED"), { code: "CANCELLED" });
        store.getState().setPair({
          ...base,
          status: "ready",
          autoOffset: r.offsetY,
          offset: r.offsetY,
          confidence: r.status === "matched" ? r.confidenceClass : "low",
          matched: r.status === "matched",
          bands: r.bands,
          matchScore: r.confidence,
          matchNotes: r.breakdown?.caps ?? [],
          matchReason: r.reason,
        });
        job(`analyse:${key}`, "stitch-analyse", "done", 1);
      } catch (e) {
        if (!owns()) continue;
        const code = abort.signal.aborted ? "CANCELLED" : codeOf(e);
        if (inputsPresent()) store.getState().setPair({ ...base, status: "failed", error: code });
        job(`analyse:${key}`, "stitch-analyse", code === "CANCELLED" ? "cancelled" : "failed", null, code);
      }
    }
    } finally {
      if (activeStitchAnalysisAbort === abort) { activeStitchAnalysisAbort = null; stitchAnalysisRun = null; }
    } })();
    return stitchAnalysisRun;
  }

  function stitchPlan(): ChainPlan | null {
    const s = store.getState();
    const originals = selectOriginals(s);
    const keys = selectJoinKeys(s);
    if (originals.length < 2) return null;
    const pairs = keys.map((k) => s.stitch.pairs[k]);
    if (pairs.some((p) => !p || p.status !== "ready")) return null;
    return planStitchChain(
      originals.map((f) => ({ width: f.width, height: f.height })),
      pairs.map((p) => ({ offsetY: p.offset, bands: p.bands })),
    );
  }

  async function exportStitch(): Promise<StitchExportResult> {
    const s = store.getState();
    const plan = stitchPlan();
    if (!plan) throw Object.assign(new Error("not ready"), { code: "STITCH_NOT_READY" });
    const originals = selectOriginals(s);
    const images = originals.map((f) => registry.blob(f.id)!);
    const sources = originals.map((f) => ({ width: f.width, height: f.height }));
    const { format, quality } = s.exportSettings;
    activeStitchExportAbort?.abort();
    const abort = new AbortController();
    activeStitchExportAbort = abort;
    const signature = JSON.stringify({ plan, ids: originals.map(f => f.id), format, quality });
    const current = () => !disposed && !abort.signal.aborted && activeStitchExportAbort === abort &&
      images.every((blob, i) => registry.blob(originals[i].id) === blob) &&
      JSON.stringify({ plan: stitchPlan(), ids: selectOriginals(store.getState()).map(f => f.id), format: store.getState().exportSettings.format, quality: store.getState().exportSettings.quality }) === signature;
    const jobId = `export:${Date.now()}`;
    job(jobId, "stitch-export", "running", 0);
    // Never keep the OpenCV runtime alive during composition (Spike B).
    broker.release("vision");
    try {
      // The main-thread fallback is imported on demand so page bundles never ship the encoder.
      const composePlan = { width: plan.width, height: plan.height, segments: plan.segments };
      const result = caps.offscreenCanvas
        ? await broker.run("image", "stitch.composeChain", { images, plan: composePlan, sources, format, quality }, { signal: abort.signal, onProgress: (p) => { if (current()) job(jobId, "stitch-export", "running", p); } })
        : await (await import("@/core/stitch/compose-chain")).composeChain(images, composePlan, {
            format,
            quality,
            sources,
            signal: abort.signal,
            createCanvas: (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h }),
            yieldBetweenTiles: timeSlicer(),
            onProgress: (p) => { if (current()) job(jobId, "stitch-export", "running", p); },
          });
      if (!current()) throw Object.assign(new Error("CANCELLED"), { code: "CANCELLED" });
      // Large outputs: recycle the worker so decoded memory is returned (Spike B/D).
      if (plan.width * plan.height > 16_000_000) broker.release("image");
      const id = newId();
      const mime: ImageMime = format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : "image/webp";
      registry.put(id, result.blob);
      store.getState().addArtifact({
        id,
        name: `stitched-screenshot.${EXT[mime]}`,
        type: mime,
        bytes: result.blob.size,
        width: result.width,
        height: result.height,
        source: "artifact",
        kind: "artifact",
        derivedFrom: originals.map((f) => f.id),
        producedBy: "stitch",
        addedAt: Date.now(),
        previewVersion: 0,
      });
      job(jobId, "stitch-export", "done", 1);
      void makePreview(id);
      return { id, width: result.width, height: result.height, bytes: result.blob.size };
    } catch (e) {
      const code = abort.signal.aborted ? "CANCELLED" : codeOf(e);
      job(jobId, "stitch-export", code === "CANCELLED" ? "cancelled" : "failed", null, code);
      throw Object.assign(new Error(code), { code });
    } finally {
      if (activeStitchExportAbort === abort) activeStitchExportAbort = null;
    }
  }

  async function exportCombine(inputIds: FileId[], plan: CombinePlan): Promise<CombineExportResult> {
    if (inputIds.length < 2 || plan.placements.length !== inputIds.length) throw Object.assign(new Error("Invalid composition"), { code: "COMBINE_INVALID_LAYOUT" });
    const s = store.getState();
    const inputs = inputIds.map((id) => s.files[id]);
    const images = inputIds.map((id) => registry.blob(id));
    if (inputs.some((file) => !file) || images.some((blob) => !blob)) throw Object.assign(new Error("Missing source"), { code: "DECODE_FAILED" });
    const { format, quality } = s.exportSettings;
    const jobId = `combine:${Date.now()}`;
    job(jobId, "combine-export", "running", 0);
    try {
      const result = caps.offscreenCanvas
        ? await broker.run("image", "combine.compose", { images: images as Blob[], plan, format, quality }, { onProgress: (progress) => job(jobId, "combine-export", "running", progress) })
        : await (await import("@/core/combine/compose")).composeCombine(images as Blob[], plan, {
            format,
            quality,
            createCanvas: (width, height) => Object.assign(document.createElement("canvas"), { width, height }),
            yieldBetweenTiles: timeSlicer(),
            onProgress: (progress) => job(jobId, "combine-export", "running", progress),
          });
      if (result.width * result.height > 16_000_000) broker.release("image");
      const mime: ImageMime = format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : "image/webp";
      const id = newId();
      registry.put(id, result.blob);
      store.getState().addArtifact({
        id,
        name: `combined-screenshots.${EXT[mime]}`,
        type: mime,
        bytes: result.blob.size,
        width: result.width,
        height: result.height,
        source: "artifact",
        kind: "artifact",
        derivedFrom: [...inputIds],
        producedBy: "combine",
        addedAt: Date.now(),
        previewVersion: 0,
      });
      job(jobId, "combine-export", "done", 1);
      void makePreview(id);
      return { id, width: result.width, height: result.height, bytes: result.blob.size };
    } catch (error) {
      const code = codeOf(error);
      job(jobId, "combine-export", "failed", null, code);
      throw Object.assign(new Error(code), { code });
    }
  }

  async function exportEdit(assetId?: FileId): Promise<EditorExportResult> {
    const { id: sourceId, file, blob } = selected(assetId);
    const s = store.getState();
    const transform = s.editor.byAsset[sourceId] ?? IDENTITY_TRANSFORM;
    // Nothing changed: exporting would only re-encode the original.
    if (isIdentity(transform)) throw Object.assign(new Error("No edits"), { code: "EDITOR_INVALID_TRANSFORM" });
    const source = { width: file.width, height: file.height };
    const { format, quality } = s.exportSettings;
    const jobId = `editor:${Date.now()}`;
    job(jobId, "editor-export", "running", 0);
    try {
      const onProgress = (progress: number) => job(jobId, "editor-export", "running", progress);
      const result = caps.offscreenCanvas
        ? await broker.run("image", "transform.export", { image: blob, transform, source, format, quality }, { onProgress })
        : await (await import("@/core/image-transform/render")).renderTransform(blob, transform, {
            source,
            format,
            quality,
            createCanvas: (width, height) => Object.assign(document.createElement("canvas"), { width, height }),
            yieldBetweenTiles: timeSlicer(),
            onProgress,
          });
      // Large outputs: recycle the worker so decoded memory is returned (Spike B).
      // The whole source was decoded even when a crop makes the output small: size by the larger.
      if (Math.max(result.width * result.height, source.width * source.height) > 16_000_000) broker.release("image");
      const mime: ImageMime = format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : "image/webp";
      const base = file.name.replace(/\.[^.]+$/, "").replace(/^edited-/, "");
      const id = newId();
      registry.put(id, result.blob);
      // A new artifact: the source asset and its blob are left exactly as they were.
      store.getState().addArtifact({
        id,
        name: `edited-${base}.${EXT[mime]}`,
        type: mime,
        bytes: result.blob.size,
        width: result.width,
        height: result.height,
        source: "artifact",
        kind: "artifact",
        derivedFrom: [sourceId],
        producedBy: "editor",
        addedAt: Date.now(),
        previewVersion: 0,
      });
      job(jobId, "editor-export", "done", 1);
      void makePreview(id);
      return { id, width: result.width, height: result.height, bytes: result.blob.size, sourceId };
    } catch (error) {
      const code = codeOf(error);
      job(jobId, "editor-export", "failed", null, code);
      throw Object.assign(new Error(code), { code });
    }
  }

  async function exportAnnotated(assetId?: FileId): Promise<EditorExportResult> {
    const { id: sourceId, file, blob } = selected(assetId);
    const s = store.getState();
    const annotations = s.annotation.byAsset[sourceId] ?? [];
    if (!annotations.length) throw Object.assign(new Error("No annotations"), { code: "ANNOTATION_EMPTY" });
    // Annotations sit on top of the asset's pending Screenshot Editor transform, exactly as previewed.
    const transform = s.editor.byAsset[sourceId] ?? IDENTITY_TRANSFORM;
    const source = { width: file.width, height: file.height };
    const { format, quality } = s.exportSettings;
    const jobId = `annotate:${Date.now()}`;
    job(jobId, "annotate-export", "running", 0);
    try {
      const onProgress = (progress: number) => job(jobId, "annotate-export", "running", progress);
      const result = caps.offscreenCanvas
        ? await broker.run("image", "annotation.export", { image: blob, transform, annotations, source, format, quality }, { onProgress })
        : await (await import("@/core/annotation/export")).renderAnnotated(blob, transform, annotations, {
            source,
            format,
            quality,
            createCanvas: (width, height) => Object.assign(document.createElement("canvas"), { width, height }),
            yieldBetweenTiles: timeSlicer(),
            onProgress,
          });
      // The whole source was decoded even when a crop makes the output small: size by the larger.
      if (Math.max(result.width * result.height, source.width * source.height) > 16_000_000) broker.release("image");
      const mime: ImageMime = format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : "image/webp";
      const base = file.name.replace(/\.[^.]+$/, "").replace(/^annotated-/, "");
      const id = newId();
      registry.put(id, result.blob);
      // A new artifact: the source keeps its blob, its annotations and its pending transform.
      store.getState().addArtifact({
        id,
        name: `annotated-${base}.${EXT[mime]}`,
        type: mime,
        bytes: result.blob.size,
        width: result.width,
        height: result.height,
        source: "artifact",
        kind: "artifact",
        derivedFrom: [sourceId],
        producedBy: "annotate",
        addedAt: Date.now(),
        previewVersion: 0,
      });
      job(jobId, "annotate-export", "done", 1);
      void makePreview(id);
      return { id, width: result.width, height: result.height, bytes: result.blob.size, sourceId };
    } catch (error) {
      const code = codeOf(error);
      job(jobId, "annotate-export", "failed", null, code);
      throw Object.assign(new Error(code), { code });
    }
  }

  async function exportSplit(assetId?: FileId): Promise<SplitRunResult> {
    const { id: sourceId, file, blob } = selected(assetId);
    const s = store.getState();
    const source = { width: file.width, height: file.height };
    const { defaultSplit, planSplit, pieceName } = await import("@/core/split/plan");
    const splitSettings = s.split.byAsset[sourceId] ?? defaultSplit(source);
    const pieces = planSplit(splitSettings, source);
    const { format, quality } = s.exportSettings;
    const jobId = `split:${Date.now()}`;
    job(jobId, "split-export", "running", 0);
    try {
      const onProgress = (progress: number) => job(jobId, "split-export", "running", progress);
      const result = caps.offscreenCanvas
        ? await broker.run("image", "split.export", { image: blob, pieces, source, format, quality }, { onProgress })
        : await (await import("@/core/split/render")).renderSplit(blob, pieces, {
            source,
            format,
            quality,
            createCanvas: (width, height) => Object.assign(document.createElement("canvas"), { width, height }),
            yieldBetweenTiles: timeSlicer(),
            onProgress,
          });
      // The whole source was decoded once: recycle the worker so that memory is returned (Spike B).
      if (source.width * source.height > 16_000_000) broker.release("image");
      const mime: ImageMime = format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : "image/webp";
      job(jobId, "split-export", "done", 1);
      return {
        sourceId,
        strategy: result.strategy,
        ms: result.ms,
        pieces: result.pieces.map((p, i) => ({ name: pieceName(i, pieces.length, EXT[mime], splitSettings.namingTemplate), type: mime, blob: p.blob, width: p.width, height: p.height, bytes: p.blob.size, y0: pieces[i].y0, y1: pieces[i].y1 })),
      };
    } catch (error) {
      const code = codeOf(error);
      job(jobId, "split-export", "failed", null, code);
      throw Object.assign(new Error(code), { code });
    }
  }

  function cancelCompareExport() { activeCompareExportAbort?.abort(); }

  async function exportCompare(): Promise<EditorExportResult> {
    const s = store.getState();
    const settings = s.compare;
    const fileA = settings.a ? s.files[settings.a] : undefined;
    const fileB = settings.b ? s.files[settings.b] : undefined;
    const blobA = settings.a ? registry.blob(settings.a) : undefined;
    const blobB = settings.b ? registry.blob(settings.b) : undefined;
    if (!settings.a || !settings.b || !fileA || !fileB || !blobA || !blobB) throw Object.assign(new Error("Two screenshots"), { code: "COMPARE_NEEDS_TWO" });
    const a = { width: fileA.width, height: fileA.height };
    const b = { width: fileB.width, height: fileB.height };
    const { format, quality } = s.exportSettings;
    activeCompareExportAbort?.abort();
    const abort = new AbortController();
    activeCompareExportAbort = abort;
    const signature = JSON.stringify({settings,format,quality});
    const current = () => !disposed && !abort.signal.aborted && activeCompareExportAbort === abort && registry.blob(settings.a!) === blobA && registry.blob(settings.b!) === blobB && JSON.stringify({settings:store.getState().compare,format:store.getState().exportSettings.format,quality:store.getState().exportSettings.quality}) === signature;
    const check = () => { if (!current()) throw Object.assign(new Error("COMPARE_CANCELLED"), { code:"COMPARE_CANCELLED" }); };
    const jobId = `compare:${Date.now()}`;
    job(jobId, "compare-export", "running", 0);
    try {
      const onProgress = (progress: number) => { if (current()) job(jobId, "compare-export", "running", progress); };
      // The export applies the SAME measured alignment the preview showed, not a new one.
      const alignment = settings.alignment.mode === "off" ? null : await alignCompare();
      check();
      const result = caps.offscreenCanvas
        ? await broker.run("image", "compare.export", { imageA: blobA, imageB: blobB, settings, a, b, alignment, format, quality }, { signal:abort.signal, onProgress })
        : await (await import("@/core/compare/render")).renderCompare(blobA, blobB, settings, {
            a,
            b,
            alignment,
            format,
            quality,
            signal: abort.signal,
            createCanvas: (width, height) => Object.assign(document.createElement("canvas"), { width, height }),
            onProgress,
          });
      // Both sources are decoded whatever the output size: size the recycle by the largest.
      if (Math.max(result.width * result.height, a.width * a.height, b.width * b.height) > 16_000_000) broker.release("image");
      const mime: ImageMime = format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : "image/webp";
      const { COMPARE_NAMES } = await import("@/core/compare/presets");
      check();
      const id = newId();
      registry.put(id, result.blob);
      // Two parents: the comparison is derived from both screenshots, and neither is changed.
      store.getState().addArtifact({
        id,
        name: `${COMPARE_NAMES[settings.mode]}.${EXT[mime]}`,
        type: mime,
        bytes: result.blob.size,
        width: result.width,
        height: result.height,
        source: "artifact",
        kind: "artifact",
        derivedFrom: [settings.a, settings.b],
        producedBy: "compare",
        addedAt: Date.now(),
        previewVersion: 0,
      });
      job(jobId, "compare-export", "done", 1);
      void makePreview(id);
      return { id, width: result.width, height: result.height, bytes: result.blob.size, sourceId: settings.a };
    } catch (error) {
      const code = !current() ? "COMPARE_CANCELLED" : codeOf(error);
      job(jobId, "compare-export", code === "COMPARE_CANCELLED" ? "cancelled" : "failed", null, code);
      throw Object.assign(new Error(code), { code });
    } finally {
      if (activeCompareExportAbort === abort) activeCompareExportAbort = null;
    }
  }

  /* --------------------------------------------------------------- Compare Pro */

  /** Canvas factory for the small, bounded Compare analyses that run on the page. */
  const compareCanvas = (width: number, height: number): OffscreenCanvas | HTMLCanvasElement =>
    typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });

  /** The chosen pair, or a controlled error. Nothing in Compare Pro works without both. */
  function compareContext() {
    const s = store.getState();
    const settings = s.compare;
    const fileA = settings.a ? s.files[settings.a] : undefined;
    const fileB = settings.b ? s.files[settings.b] : undefined;
    if (!settings.a || !settings.b || !fileA || !fileB) throw Object.assign(new Error("Two screenshots"), { code: "COMPARE_NEEDS_TWO" });
    return {
      settings,
      idA: settings.a,
      idB: settings.b,
      fileA,
      fileB,
      sizeA: { width: fileA.width, height: fileA.height },
      sizeB: { width: fileB.width, height: fileB.height },
      pair: comparePairKey(settings.a, settings.b),
    };
  }

  const bumpCompare = () => store.getState().setCompareRun({ version: store.getState().compareRun.version + 1 });

  /**
   * Measure the alignment from small greyscale proxies of the two preview bitmaps (the
   * originals are never decoded for this). The result is cached against the inputs it
   * depended on, so moving a slider, changing sensitivity or drawing an ignore region never
   * re-measures anything.
   */
  async function alignCompare(force = false): Promise<CompareAlignEstimate> {
    const { settings, idA, idB, fileA, fileB, sizeA, sizeB, pair } = compareContext();
    const key = compareAlignKey(settings, sizeA, sizeB);
    if (!force) {
      const cached = compareAnalyses.alignment(pair, key);
      if (cached) return cached;
    }
    if (settings.alignment.mode === "off") {
      const off: CompareAlignEstimate = { status: "off", dx: 0, dy: 0, scale: 1, score: 0, confidence: "high", method: "off", analysisScale: 1 };
      compareAnalyses.setAlignment(pair, key, off);
      store.getState().setCompareRun({ pair, align: { status: "idle", error: undefined } });
      bumpCompare();
      return off;
    }
    const jobId = `compare-align:${pair}`;
    job(jobId, "compare-align", "running", null);
    store.getState().setCompareRun({ pair, align: { status: "running", error: undefined } });
    try {
      const [{ compareLayout }, { compareProxies }, { alignGray }, { ALIGN_ANALYSIS_WIDTH }] = await Promise.all([
        import("@/core/compare/layout"),
        import("@/core/compare/draw"),
        import("@/core/compare/align"),
        import("@/core/compare/presets"),
      ]);
      const bitmapA = registry.preview(idA);
      const bitmapB = registry.preview(idB);
      if (!bitmapA || !bitmapB) {
        // Previews are still being generated; do NOT cache this, so it is measured properly
        // the moment they arrive.
        job(jobId, "compare-align", "done", 1);
        store.getState().setCompareRun({ pair, align: { status: "idle", error: undefined } });
        return { status: "failed", dx: 0, dy: 0, scale: 1, score: 0, confidence: "low", method: settings.alignment.mode, analysisScale: 1, reason: "too-small" };
      }
      let estimate: CompareAlignEstimate;
      {
        // Measure from the UNALIGNED placement, so the estimate is absolute.
        const unaligned = { ...settings, alignment: { mode: "off" as const, dx: 0, dy: 0, scale: 1 } };
        const layout = compareLayout(unaligned, { size: sizeA, name: fileA.name }, { size: sizeB, name: fileB.name }, null);
        const proxies = compareProxies(
          layout,
          { image: bitmapA, imageScale: bitmapA.width / fileA.width },
          { image: bitmapB, imageScale: bitmapB.width / fileB.width },
          ALIGN_ANALYSIS_WIDTH,
          compareCanvas,
        );
        estimate = proxies
          ? alignGray(proxies.a, proxies.b, { mode: settings.alignment.mode, analysisScale: 1 / Math.max(0.0001, proxies.scale) })
          : { status: "failed", dx: 0, dy: 0, scale: 1, score: 0, confidence: "low", method: settings.alignment.mode, analysisScale: 1, reason: "no-texture" };
      }
      compareAnalyses.setAlignment(pair, key, estimate);
      store.getState().setCompareRun({ pair, align: { status: estimate.status === "failed" ? "failed" : "done", error: estimate.reason } });
      bumpCompare();
      job(jobId, "compare-align", "done", 1);
      return estimate;
    } catch (error) {
      const code = codeOf(error);
      job(jobId, "compare-align", "failed", null, code);
      store.getState().setCompareRun({ pair, align: { status: "failed", error: code } });
      // A failed measurement is never fatal: the comparison simply runs unaligned.
      const failure: CompareAlignEstimate = { status: "failed", dx: 0, dy: 0, scale: 1, score: 0, confidence: "low", method: settings.alignment.mode, analysisScale: 1, reason: "low-score" };
      compareAnalyses.setAlignment(pair, key, failure);
      bumpCompare();
      return failure;
    }
  }

  function resetCompareAlignment(): void {
    const s = store.getState();
    if (!s.compare.a || !s.compare.b) return;
    compareAnalyses.clearAlignment(comparePairKey(s.compare.a, s.compare.b));
    s.setCompareRun({ align: { status: "idle", error: undefined } });
    bumpCompare();
  }

  /**
   * OCR both screenshots and diff the visible text. OCR results already in this session are
   * reused, so a second run on the same pair is just the comparison. Stages are the real ones;
   * there is no synthetic percentage, because OCR cannot report one meaningfully here.
   */
  async function analyseCompareText(onStage?: (stage: string) => void): Promise<CompareTextDiff> {
    const { idA, idB, pair } = compareContext();
    await cancelCompareText(true);
    const abort = new AbortController();
    activeCompareTextAbort = abort;
    const jobId = `compare-text:${pair}`;
    job(jobId, "compare-text", "running", null);
    const stage = (text: string) => {
      onStage?.(text);
      store.getState().setCompareRun({ pair, text: { status: "running", progress: null, stage: text, error: undefined } });
    };
    const guard = () => {
      if (abort.signal.aborted) throw Object.assign(new Error("COMPARE_CANCELLED"), { code: "COMPARE_CANCELLED" });
    };
    try {
      const started = typeof performance !== "undefined" ? performance.now() : Date.now();
      stage("Reading before…");
      let ocrA = ocrResults.forAsset(idA);
      if (!ocrA) {
        stage("Extracting text from before…");
        ocrA = (await extractText(idA, undefined, true)).result;
      }
      guard();
      stage("Reading after…");
      let ocrB = ocrResults.forAsset(idB);
      if (!ocrB) {
        stage("Extracting text from after…");
        ocrB = (await extractText(idB, undefined, true)).result;
      }
      guard();
      stage("Comparing visible text…");
      const { diffOcrText } = await import("@/core/compare/text-diff");
      const diff = diffOcrText(ocrA, ocrB, started);
      guard();
      compareAnalyses.setTextDiff(pair, diff);
      store.getState().setCompareRun({ pair, text: { status: "done", progress: null, stage: undefined, error: undefined } });
      bumpCompare();
      job(jobId, "compare-text", "done", 1);
      toast({
        type: "success",
        message: "Text compared",
        description: diff.changes.length ? `${diff.changes.length} visible text change${diff.changes.length === 1 ? "" : "s"} found.` : "No visible text change was detected.",
      });
      return diff;
    } catch (error) {
      const raw = codeOf(error);
      const cancelled = raw === "COMPARE_CANCELLED" || raw === "OCR_CANCELLED" || raw === "CANCELLED" || abort.signal.aborted;
      const code = cancelled ? "COMPARE_CANCELLED" : raw.startsWith("OCR_") ? raw : "COMPARE_TEXT_FAILED";
      job(jobId, "compare-text", cancelled ? "cancelled" : "failed", null, code);
      store.getState().setCompareRun({ pair, text: { status: cancelled ? "cancelled" : "failed", progress: null, stage: undefined, error: code } });
      // The visual comparison is untouched by a text-diff failure, and stays on screen.
      if (!cancelled) toast({ type: "error", message: "Text comparison failed", description: "The visual comparison is unaffected. Both screenshots stayed on this device." });
      throw Object.assign(new Error(code), { code });
    } finally {
      if (activeCompareTextAbort === abort) activeCompareTextAbort = null;
    }
  }

  async function cancelCompareText(silent = false): Promise<void> {
    const active = activeCompareTextAbort;
    if (!active) return;
    active.abort();
    activeCompareTextAbort = null;
    await cancelOcr(undefined, true);
    store.getState().setCompareRun({ text: { status: "cancelled", progress: null, stage: undefined } });
    if (!silent) toast({ type: "info", message: "Text comparison cancelled" });
  }

  function publishCompareAnalysis(analysis: CompareVisualAnalysis | null): void {
    const s = store.getState();
    if (!s.compare.a || !s.compare.b) return;
    compareAnalyses.setVisual(comparePairKey(s.compare.a, s.compare.b), analysis);
  }

  /**
   * Headless measurement: build the difference view at a bounded analysis width, run the
   * same engine the preview runs, publish the result. No new comparison logic lives here.
   */
  async function measureCompare(maxWidth = 1200): Promise<CompareVisualAnalysis | null> {
    const { settings, idA, idB, fileA, fileB, sizeA, sizeB, pair } = compareContext();
    const signature = JSON.stringify(settings);
    const bitmapA = registry.preview(idA);
    const bitmapB = registry.preview(idB);
    if (!bitmapA || !bitmapB) return null;
    const estimate = settings.alignment.mode === "off" ? null : await alignCompare();
    const [{ compareLayout }, { drawCompare }] = await Promise.all([import("@/core/compare/layout"), import("@/core/compare/draw")]);
    const layout = compareLayout(
      { ...settings, mode: settings.mode === "heatmap" ? "heatmap" : "difference", labels: false },
      { size: sizeA, name: fileA.name },
      { size: sizeB, name: fileB.name },
      estimate,
    );
    const scale = Math.min(1, maxWidth / layout.canvas.width);
    const width = Math.max(1, Math.round(layout.canvas.width * scale));
    const height = Math.max(1, Math.round(layout.canvas.height * scale));
    const canvas = compareCanvas(width, height);
    try {
      const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!ctx) return null;
      const analysis = drawCompare(
        ctx as never,
        layout,
        { image: bitmapA, imageScale: bitmapA.width / fileA.width },
        { image: bitmapB, imageScale: bitmapB.width / fileB.width },
        width,
        height,
        { createCanvas: compareCanvas },
      );
      const textDiff = compareAnalyses.textDiff(pair);
      let enriched = analysis;
      if (analysis && textDiff?.changes.length) {
        const { applyTextChanges } = await import("@/core/compare/analysis");
        enriched = applyTextChanges(analysis, textDiff, { a: layout.a, b: layout.b });
      }
      if (disposed || JSON.stringify(store.getState().compare) !== signature || registry.preview(idA) !== bitmapA || registry.preview(idB) !== bitmapB) return null;
      compareAnalyses.setVisual(pair, enriched);
      bumpCompare();
      return enriched;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  /**
   * Bounded PNG renders of the views the report includes, drawn from the preview bitmaps
   * through the SAME layout the preview uses. Bounded on purpose: a report does not need
   * full-resolution pages, and this keeps the peak memory of generating one small.
   */
  async function compareReportImages(estimate: CompareAlignEstimate | null, maxWidth = 1400): Promise<{ before?: Blob; after?: Blob; difference?: Blob; heatmap?: Blob }> {
    const { settings, idA, idB, fileA, fileB, sizeA, sizeB } = compareContext();
    const bitmapA = registry.preview(idA);
    const bitmapB = registry.preview(idB);
    if (!bitmapA || !bitmapB) return {};
    const [{ compareLayout }, { drawCompare }] = await Promise.all([import("@/core/compare/layout"), import("@/core/compare/draw")]);
    const sourceA = { image: bitmapA, imageScale: bitmapA.width / fileA.width };
    const sourceB = { image: bitmapB, imageScale: bitmapB.width / fileB.width };

    const single = async (bitmap: ImageBitmap) => {
      const scale = Math.min(1, maxWidth / bitmap.width);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = compareCanvas(width, height);
      try {
        const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (!ctx) return undefined;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, width, height);
        return (await encodeCanvas(canvas, "png")) ?? undefined;
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    };

    const view = async (mode: "difference" | "heatmap") => {
      const layout = compareLayout({ ...settings, mode, labels: true }, { size: sizeA, name: fileA.name }, { size: sizeB, name: fileB.name }, estimate);
      const scale = Math.min(1, maxWidth / layout.canvas.width);
      const width = Math.max(1, Math.round(layout.canvas.width * scale));
      const height = Math.max(1, Math.round(layout.canvas.height * scale));
      const canvas = compareCanvas(width, height);
      try {
        const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (!ctx) return undefined;
        drawCompare(ctx as never, layout, sourceA, sourceB, width, height, { createCanvas: compareCanvas });
        return (await encodeCanvas(canvas, "png")) ?? undefined;
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    };

    return {
      before: await single(bitmapA),
      after: await single(bitmapB),
      difference: await view("difference"),
      heatmap: await view("heatmap"),
    };
  }

  /**
   * Build and download the Shotexa Visual Comparison Report. "json" is the machine-readable
   * summary only; "pdf" is the document; "zip" packages the images, the PDF and the JSON.
   */
  async function exportCompareReport(kind: CompareReportKind, options: { download?: boolean } = {}): Promise<{ blob: Blob; name: string }> {
    const { settings, idA, idB, fileA, fileB, pair } = compareContext();
    activeCompareReportAbort?.abort();
    const abort = new AbortController();
    activeCompareReportAbort = abort;
    const settingsSignature = JSON.stringify(settings);
    const reportCurrent = () => !disposed && !abort.signal.aborted && activeCompareReportAbort === abort && JSON.stringify(store.getState().compare) === settingsSignature && !!registry.blob(idA) && !!registry.blob(idB);
    const checkReport = () => { if (!reportCurrent()) throw Object.assign(new Error("COMPARE_CANCELLED"), { code: "COMPARE_CANCELLED" }); };
    const jobId = `compare-report:${pair}`;
    job(jobId, "compare-report", "running", null);
    const setStage = (text: string) => { checkReport(); store.getState().setCompareRun({ pair, report: { status: "running", kind, stage: text, error: undefined } }); };
    setStage("Collecting measurements…");
    try {
      const [{ buildCompareSummary, summaryToJson }, { COMPARE_REPORT_NAMES }] = await Promise.all([import("@/core/compare/summary"), import("@/core/compare/presets")]);
      const estimate = settings.alignment.mode === "off" ? null : await alignCompare();
      // A report always carries a measurement, even if the user never opened Difference.
      checkReport();
      setStage("Measuring the difference…");
      const reportAnalysis = await measureCompare();
      checkReport();
      if (!reportAnalysis) throw Object.assign(new Error("COMPARE_REPORT_FAILED"), { code: "COMPARE_REPORT_FAILED" });
      const [alphaA, alphaB] = await Promise.all([hasTransparency(idA), hasTransparency(idB)]);
      const summary = buildCompareSummary({
        a: { name: fileA.name, width: fileA.width, height: fileA.height, bytes: fileA.bytes, type: fileA.type, transparent: alphaA },
        b: { name: fileB.name, width: fileB.width, height: fileB.height, bytes: fileB.bytes, type: fileB.type, transparent: alphaB },
        settings,
        alignment: estimate,
        analysis: reportAnalysis,
        textDiff: compareAnalyses.textDiff(pair),
      });
      checkReport();
      let blob: Blob;
      let name: string;
      if (kind === "json") {
        blob = new Blob([summaryToJson(summary)], { type: "application/json;charset=utf-8" });
        name = COMPARE_REPORT_NAMES.json;
      } else {
        setStage("Rendering comparison views…");
        const images = await compareReportImages(estimate);
        if (abort.signal.aborted) throw Object.assign(new Error("COMPARE_CANCELLED"), { code: "COMPARE_CANCELLED" });
        setStage("Writing the PDF…");
        const { createCompareReportPdf, createCompareReportZip } = await import("@/core/compare/report");
        const pdf = await createCompareReportPdf({ summary, images, signal: abort.signal });
        if (kind === "pdf") {
          blob = pdf;
          name = COMPARE_REPORT_NAMES.pdf;
        } else {
          setStage("Packaging the report…");
          blob = (await createCompareReportZip({ summary, images, pdf, signal: abort.signal })).blob;
          name = COMPARE_REPORT_NAMES.zip;
        }
      }
      checkReport();
      compareAnalyses.setReport(pair, { kind, name, blob, createdAt: Date.now() });
      store.getState().setCompareRun({ pair, report: { status: "done", kind, stage: undefined, error: undefined } });
      bumpCompare();
      job(jobId, "compare-report", "done", 1);
      if (options.download !== false) downloadBlob(blob, name);
      return { blob, name };
    } catch (error) {
      const raw = codeOf(error);
      const cancelled = raw === "COMPARE_CANCELLED" || !reportCurrent();
      const code = cancelled ? "COMPARE_CANCELLED" : raw === "ZIP_TOO_LARGE" || raw === "ZIP_EMPTY" || raw === "ZIP_CREATE_FAILED" ? raw : "COMPARE_REPORT_FAILED";
      if (activeCompareReportAbort === abort) {
        job(jobId, "compare-report", cancelled ? "cancelled" : "failed", null, code);
        store.getState().setCompareRun({ pair, report: { status: cancelled ? "idle" : "failed", kind, stage: undefined, error: code } });
      }
      if (!cancelled) toast({ type: "error", message: "Report not created", description: "The comparison itself is unaffected. Try the JSON summary, or a smaller comparison." });
      throw Object.assign(new Error(code, { cause: error }), { code });
    } finally {
      if (activeCompareReportAbort === abort) activeCompareReportAbort = null;
    }
  }

  async function exportBeautified(assetId?: FileId): Promise<EditorExportResult> {
    const { id: sourceId, file, blob } = selected(assetId);
    const s = store.getState();
    const source = { width: file.width, height: file.height };
    const { DEFAULT_BEAUTIFY } = await import("@/core/beautify/presets");
    const settings = s.beautify.byAsset[sourceId] ?? DEFAULT_BEAUTIFY;
    const resourceIds = [...new Set([...settings.composition.assetIds, settings.branding.assetId, settings.background.assetId, ...(settings.watermarks ?? []).map((layer) => layer.assetId)].filter((id): id is string => !!id && id !== sourceId))];
    const resources = resourceIds.flatMap((id) => {
      const resourceFile = s.files[id];
      const resourceBlob = registry.blob(id);
      return resourceFile && resourceBlob ? [{ id, image: resourceBlob, source: { width: resourceFile.width, height: resourceFile.height } }] : [];
    });
    const { format, quality } = s.exportSettings;
    const jobId = `beautify:${Date.now()}`;
    job(jobId, "beautify-export", "running", 0);
    try {
      const onProgress = (progress: number) => job(jobId, "beautify-export", "running", progress);
      const result = caps.offscreenCanvas
        ? await broker.run("image", "beautify.export", { image: blob, settings, source, resources, format, quality }, { onProgress })
        : await (await import("@/core/beautify/render")).renderBeautified(blob, settings, {
            source,
            resources,
            format,
            quality,
            createCanvas: (width, height) => Object.assign(document.createElement("canvas"), { width, height }),
            yieldBetweenTiles: timeSlicer(),
            onProgress,
          });
      // Every selected local resource is decoded for this composition; recycle by their total.
      if (Math.max(result.width * result.height, source.width * source.height + resources.reduce((total, resource) => total + resource.source.width * resource.source.height, 0)) > 16_000_000) broker.release("image");
      const mime: ImageMime = format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : "image/webp";
      const base = file.name.replace(/\.[^.]+$/, "").replace(/^beautified-/, "");
      const id = newId();
      registry.put(id, result.blob);
      // A new artifact: the source keeps its blob and its composition settings.
      store.getState().addArtifact({
        id,
        name: `beautified-${base}.${EXT[mime]}`,
        type: mime,
        bytes: result.blob.size,
        width: result.width,
        height: result.height,
        source: "artifact",
        kind: "artifact",
        derivedFrom: [sourceId, ...resourceIds],
        producedBy: "beautify",
        addedAt: Date.now(),
        previewVersion: 0,
      });
      job(jobId, "beautify-export", "done", 1);
      void makePreview(id);
      return { id, width: result.width, height: result.height, bytes: result.blob.size, sourceId };
    } catch (error) {
      const code = codeOf(error);
      job(jobId, "beautify-export", "failed", null, code);
      throw Object.assign(new Error(code), { code });
    }
  }

  async function encodeAsset(tool: EncodeTool, assetId?: FileId, options: { signal?: AbortSignal; measureAlternative?: boolean } = {}): Promise<EncodeRunResult> {
    const { id: sourceId, file, blob } = selected(assetId);
    const settings = { ...store.getState().encode[tool] };
    const format = resolveFormat(tool, settings.format, file.type);
    const source = { width: file.width, height: file.height };
    const percent = tool === "compress" ? resizePercent(settings.resizePercent) : 100;
    const expected = encodeSize(source, percent);
    const requestKey = encodeRequestKey(tool, sourceId, file, settings);
    const measureAlternative = options.measureAlternative !== false;
    const cacheKey = `encode:${requestKey}:${measureAlternative}`;
    // Existing API callers retain their measured PNG hint; Compressor UI measures alternatives on intent.
    const probe = measureAlternative && format === "png" ? { format: "webp" as const, quality: 0.8 } : undefined;
    const targetBytes = tool === "compress" && format !== "png" ? settings.targetBytes : null;
    const input = { source, format, quality: settings.quality, background: settings.background, probe, targetBytes, resizePercent: percent };
    return encodeSession.run(cacheKey, blob, async (signal) => {
      const jobId = `encode:${++encodeJobSequence}`;
      job(jobId, "encode", "running", 0);
      try {
        const onProgress = (progress: number) => { if (!signal.aborted) job(jobId, "encode", "running", progress); };
        const result = caps.offscreenCanvas
          ? await broker.run("image", "image.encode", { image: blob, ...input }, { signal, onProgress })
          : await track(async () => (await import("@/core/image-encode/reencode")).encodeImage(blob, {
              ...input, signal,
              createCanvas: (width, height) => Object.assign(document.createElement("canvas"), { width, height }),
              yieldBetweenTiles: timeSlicer(), onProgress,
            }));
        if (signal.aborted || disposed || registry.blob(sourceId) !== blob || encodeRequestKey(tool, sourceId, file, store.getState().encode[tool]) !== requestKey) throw new EncodeError("ENCODE_CANCELLED");
        if (result.blob.type !== FORMAT_MIME[format] || result.width !== expected.width || result.height !== expected.height) throw new EncodeError("ENCODE_VERIFY_FAILED");
        if (source.width * source.height > 16_000_000) broker.release("image");
        job(jobId, "encode", "done", 1);
        return {
          tool, sourceId, name: encodedName(tool, file.name, format), type: FORMAT_MIME[format], blob: result.blob,
          width: result.width, height: result.height, bytes: result.blob.size, originalBytes: file.bytes, format,
          quality: result.quality ?? settings.quality, requestedQuality: settings.quality, resizePercent: percent,
          background: settings.background, ms: result.ms, target: result.target, probe: result.probe,
        };
      } catch (error) {
        const code = signal.aborted || codeOf(error) === "CANCELLED" ? "ENCODE_CANCELLED" : codeOf(error);
        job(jobId, "encode", code === "ENCODE_CANCELLED" ? "cancelled" : "failed", null, code);
        throw Object.assign(new Error(code), { code });
      }
    }, (value) => value.bytes, options.signal);
  }

  async function compareEncodeFormats(assetId?: FileId, tool: EncodeTool = "convert", options: { signal?: AbortSignal } = {}): Promise<FormatComparisonRun> {
    const { id: sourceId, file, blob } = selected(assetId);
    const settings = { ...store.getState().encode[tool] };
    const source = { width: file.width, height: file.height };
    const percent = tool === "compress" ? resizePercent(settings.resizePercent) : 100;
    const expected = encodeSize(source, percent);
    const key = formatComparisonKey(tool, sourceId, file, settings);
    return encodeSession.run(key, blob, async (signal) => {
      const jobId = `encode:${++encodeJobSequence}`;
      job(jobId, "encode", "running", 0);
      try {
        const existing = OUTPUT_FORMATS.flatMap((format) => {
          const entry = encodeSession.peek<EncodeRunResult>(`encode:${encodeRequestKey(tool, sourceId, file, { ...settings, format, targetBytes: null })}:${tool !== "compress"}`, blob);
          return entry ? [{ ...entry, strategy: "single-canvas" as const } satisfies FormatCandidate] : [];
        });
        const input = { source, quality: settings.quality, background: settings.background, resizePercent: percent, existing };
        const onProgress = (progress: number) => { if (!signal.aborted) job(jobId, "encode", "running", progress); };
        const comparison = caps.offscreenCanvas
          ? await broker.run("image", "image.compareFormats", { image: blob, ...input }, { signal, onProgress })
          : await (await import("@/core/image-encode/reencode")).compareFormats(blob, {
              ...input, signal,
              createCanvas: (width, height) => Object.assign(document.createElement("canvas"), { width, height }),
              yieldBetweenTiles: timeSlicer(), onProgress,
            });
        if (signal.aborted || disposed || registry.blob(sourceId) !== blob || formatComparisonKey(tool, sourceId, file, store.getState().encode[tool]) !== key) throw new EncodeError("ENCODE_CANCELLED");
        if (comparison.candidates.length !== 3 || new Set(comparison.candidates.map((candidate) => candidate.format)).size !== 3) throw new EncodeError("ENCODE_VERIFY_FAILED");
        const candidates = comparison.candidates.map((candidate) => {
          if (candidate.blob.type !== FORMAT_MIME[candidate.format] || candidate.width !== expected.width || candidate.height !== expected.height) throw new EncodeError("ENCODE_VERIFY_FAILED");
          return {
            tool, sourceId, name: encodedName(tool, file.name, candidate.format), type: FORMAT_MIME[candidate.format],
            blob: candidate.blob, width: candidate.width, height: candidate.height, bytes: candidate.blob.size,
            originalBytes: file.bytes, format: candidate.format, quality: candidate.quality, requestedQuality: settings.quality,
            resizePercent: percent, background: settings.background, ms: comparison.ms,
          };
        });
        for (const candidate of candidates) {
          const manual = { ...settings, format: candidate.format, targetBytes: null };
          encodeSession.remember(`encode:${encodeRequestKey(tool, sourceId, file, manual)}:${tool !== "compress"}`, blob, candidate, candidate.bytes);
          if (tool === "compress" && settings.targetBytes && candidate.format !== "png" && candidate.bytes <= settings.targetBytes) {
            const targeted = { ...candidate, target: { bytes: settings.targetBytes, metTarget: true, attempts: 1 } };
            encodeSession.remember(`encode:${encodeRequestKey(tool, sourceId, file, { ...manual, targetBytes: settings.targetBytes })}:false`, blob, targeted, candidate.bytes);
          }
        }
        job(jobId, "encode", "done", 1);
        return { sourceId, candidates, ms: comparison.ms };
      } catch (error) {
        const code = signal.aborted || codeOf(error) === "CANCELLED" ? "ENCODE_CANCELLED" : codeOf(error);
        job(jobId, "encode", code === "ENCODE_CANCELLED" ? "cancelled" : "failed", null, code);
        throw Object.assign(new Error(code), { code });
      }
    }, (value) => value.candidates.reduce((sum, candidate) => sum + candidate.bytes, 0), options.signal);
  }

  function saveEncoded(result: EncodeRunResult): FileId {
    const id = newId();
    registry.put(id, result.blob);
    // A new artifact: the source keeps its blob exactly as it was.
    store.getState().addArtifact({
      id,
      name: result.name,
      type: result.type,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      source: "artifact",
      kind: "artifact",
      derivedFrom: [result.sourceId],
      producedBy: result.tool,
      addedAt: Date.now(),
      previewVersion: 0,
    });
    void makePreview(id);
    return id;
  }

  async function hasTransparency(assetId: FileId): Promise<boolean | null> {
    const file = store.getState().files[assetId];
    if (!file) return null;
    if (file.type === "image/jpeg") return false; // JPEG cannot carry transparency
    if (alphaCache.has(assetId)) return alphaCache.get(assetId)!;
    const preview = registry.preview(assetId);
    if (!preview) return null;
    const { bitmapHasAlpha } = await import("@/core/image-encode/alpha");
    const found = bitmapHasAlpha(preview, typeof OffscreenCanvas === "undefined" ? (width, height) => Object.assign(document.createElement("canvas"), { width, height }) : undefined);
    alphaCache.set(assetId, found);
    return found;
  }

  async function executeBatch(inputIds: FileId[], reset: boolean) {
    if (activeBatchAbort) throw Object.assign(new Error("Batch already running"), { code: "BATCH_RUNNING" });
    const state = store.getState();
    const ids = inputIds.filter((id, i) => !!state.files[id] && inputIds.indexOf(id) === i);
    if ((reset && ids.length < 2) || ids.length < 1) throw Object.assign(new Error("Choose at least two images"), { code: "BATCH_NEEDS_TWO" });
    if (ids.length > MAX_BATCH_FILES) throw Object.assign(new Error("Too many images"), { code: "BATCH_TOO_MANY_FILES" });
    if (ids.reduce((n, id) => n + state.files[id].bytes, 0) > MAX_BATCH_INPUT_BYTES) throw Object.assign(new Error("Inputs are too large"), { code: "BATCH_INPUT_TOO_LARGE" });
    if (reset) {
      batchResults.clear();
      store.getState().resetBatchResults();
    }
    const settings = structuredClone(store.getState().batch.settings);
    const operation = store.getState().batch.operation;
    const { filenamePrefix, filenameSuffix } = store.getState().batch;
    const allIds = [...new Set([...store.getState().batch.selectedIds, ...ids])].filter((id) => !!state.files[id]);
    const plannedNames = uniqueOutputNames(allIds.map((id) => {
      const file = store.getState().files[id] as BatchSource;
      return withAffixes(batchOutputName(operation, file.name, batchFormat(operation, file, settings)), filenamePrefix, filenameSuffix);
    }));
    const names = new Map(allIds.map((id, i) => [id, plannedNames[i]]));
    const abort = new AbortController();
    activeBatchAbort = abort;
    const jobId = `batch:${Date.now()}`;
    store.getState().setBatchRun("running", 0);
    for (const id of ids) store.getState().setBatchItem(id, { status: "pending", error: undefined, resultId: undefined });
    job(jobId, "batch", "running", 0);
    try {
      const summary = await runSequential<BatchResult>(
        ids,
        async (id, index) => {
          const current = store.getState().files[id];
          const blob = registry.blob(id);
          if (!current || !blob) throw Object.assign(new Error("Source removed"), { code: "BATCH_SOURCE_MISSING" });
          const source: BatchSource = current;
          const format = batchFormat(operation, source, settings);
          const onProgress = (p: number) => job(jobId, "batch", "running", (allIds.length - ids.length + index + p) / allIds.length);
          let output: Blob;
          let width = source.width;
          let height = source.height;
          let changed: boolean | undefined;
          if (operation === "background") {
            try {
              await removeBackground(id, () => onProgress(0.35), true);
              if (abort.signal.aborted) throw Object.assign(new Error("BACKGROUND_CANCELLED"), { code: "BACKGROUND_CANCELLED" });
              const removed = await renderBackgroundAsset(id, {
                ...DEFAULT_BACKGROUND_REMOVAL,
                edge: { ...DEFAULT_BACKGROUND_REMOVAL.edge },
                background: { kind: "transparent" },
                subject: { ...DEFAULT_BACKGROUND_REMOVAL.subject, padding: settings.background.padding },
                trim: settings.background.trim,
              }, "png", 1, undefined, abort.signal);
              output = removed.blob;
              width = removed.width;
              height = removed.height;
            } finally {
              // Batch has no mask editor; release each alpha plane before the next inference.
              backgroundMasks.remove(id);
            }
          } else if (operation === "privacy") {
            const cleaned = caps.offscreenCanvas
              ? await broker.run("image", "metadata.clean", { image: blob, name: source.name, type: source.type }, { signal: abort.signal })
              : await (await import("@/core/metadata/run")).runMetadataClean(blob, source.name, source.type);
            output = cleaned.output ?? blob;
            changed = cleaned.changed;
            if (!cleaned.verification.passed) throw Object.assign(new Error("Verification failed"), { code: "METADATA_VERIFICATION_FAILED" });
          } else if (operation === "resize") {
            const planned = resizeOutput(source, settings.resize);
            width = planned.size.width;
            height = planned.size.height;
            const quality = settings.resize.quality;
            const background = settings.resize.background;
            const rendered = caps.offscreenCanvas
              ? await broker.run("image", "transform.export", { image: blob, transform: planned.transform, source, format, quality, background }, { signal: abort.signal, onProgress })
              : await (await import("@/core/image-transform/render")).renderTransform(blob, planned.transform, {
                  source,
                  format,
                  quality,
                  background,
                  signal: abort.signal,
                  createCanvas: (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h }),
                  yieldBetweenTiles: timeSlicer(),
                  onProgress,
                });
            output = rendered.blob;
          } else {
            const encode = operation === "compress" ? settings.compress : settings.convert;
            const quality = encode.quality;
            const background = operation === "convert" ? settings.convert.background : "#ffffff";
            const encoded = caps.offscreenCanvas
              ? await broker.run("image", "image.encode", { image: blob, source, format, quality, background }, { signal: abort.signal, onProgress })
              : await (await import("@/core/image-encode/reencode")).encodeImage(blob, {
                  source,
                  format,
                  quality,
                  background,
                  signal: abort.signal,
                  createCanvas: (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h }),
                  yieldBetweenTiles: timeSlicer(),
                  onProgress,
                });
            output = encoded.blob;
          }
          const result: BatchResult = {
            id: newId(),
            sourceId: id,
            sourceName: source.name,
            outputName: operation === "privacy" && changed === false ? source.name : names.get(id)!,
            blob: output,
            bytes: output.size,
            originalBytes: source.bytes,
            type: resultMime(format),
            format,
            width,
            height,
            operation,
            changed,
          };
          // The worker is deliberately retained for small files, but a large decoded heap is
          // recycled before the next item (Spike B/Phase 2K).
          if (source.width * source.height > 16_000_000) broker.release(operation === "background" ? "background" : "image");
          return result;
        },
        abort.signal,
        {
          before: (id) => { store.getState().setBatchRun("running", allIds.indexOf(id)); store.getState().setBatchItem(id, { status: "processing" }); },
          success: (id, result, index) => { batchResults.put(result); store.getState().setBatchItem(id, { status: "completed", resultId: result.id }); job(jobId, "batch", "running", (allIds.length - ids.length + index + 1) / allIds.length); },
          failure: (id, error, index) => { store.getState().setBatchItem(id, { status: "failed", error: codeOf(error), resultId: undefined }); job(jobId, "batch", "running", (allIds.length - ids.length + index + 1) / allIds.length); },
          cancelled: (id) => store.getState().setBatchItem(id, { status: "cancelled", error: undefined, resultId: undefined }),
          // Especially important on WebKit's main-thread fallback: browser input gets a real
          // task between files, so Cancel can stop before the next full decode begins.
          between: () => caps.offscreenCanvas ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, 120)),
        },
      );
      const cancelled = abort.signal.aborted || summary.cancelled > 0;
      store.getState().setBatchRun(cancelled ? "cancelled" : "completed", null);
      job(jobId, "batch", cancelled ? "cancelled" : "done", cancelled ? null : 1);
      if (!cancelled) {
        if (summary.failed > 0) {
          toast({ type: "warning", message: "Batch completed with errors", description: `${summary.completed} processed, ${summary.failed} failed.` });
        } else {
          toast({ type: "success", message: "Batch completed", description: `${summary.completed} files processed.` });
        }
      }
      return summary;
    } finally {
      activeBatchAbort = null;
    }
  }

  function runBatch(ids = store.getState().batch.selectedIds) { return executeBatch(ids, true); }
  function cancelBatch() { activeBatchAbort?.abort(); activeBackgroundAbort?.abort(); broker.release("background"); toast({ type: "info", message: "Batch processing cancelled" }); }
  function resetBatch() { activeBatchAbort?.abort(); batchResults.clear(); store.getState().resetBatchResults(); }
  function retryBatchFailed() {
    const s = store.getState().batch;
    const ids = s.selectedIds.filter((id) => s.items[id]?.status === "failed" || s.items[id]?.status === "cancelled");
    if (!ids.length) return Promise.resolve({ completed: 0, failed: 0, cancelled: 0 });
    return executeBatch(ids, false);
  }
  async function zipBatch() {
    const s = store.getState().batch;
    const results = s.selectedIds.flatMap((id) => { const resultId = s.items[id]?.resultId; const result = resultId ? batchResults.get(resultId) : undefined; return result ? [result] : []; });
    return (await import("@/core/archive/zip")).createBatchZip(results);
  }
  function addBatchResults(): FileId[] {
    const s = store.getState().batch;
    if (s.addedToWorkspace) return [];
    const added: WorkspaceFile[] = s.selectedIds.flatMap((sourceId) => {
      const resultId = s.items[sourceId]?.resultId;
      const result = resultId ? batchResults.get(resultId) : undefined;
      if (!result) return [];
      const id = newId();
      registry.put(id, result.blob);
      return [{ id, name: result.outputName, type: result.type, bytes: result.bytes, width: result.width, height: result.height, source: "artifact" as const, kind: "artifact" as const, derivedFrom: [sourceId], producedBy: "batch" as const, addedAt: Date.now(), previewVersion: 0 }];
    });
    store.getState().addArtifacts(added);
    store.getState().markBatchAdded();
    for (const file of added) void makePreview(file.id);
    return added.map((f) => f.id);
  }

  function addSplitPieces(result: SplitRunResult): FileId[] {
    if (!store.getState().files[result.sourceId]) return [];
    const added: WorkspaceFile[] = result.pieces.map((p) => {
      const id = newId();
      registry.put(id, p.blob);
      return {
        id,
        name: p.name,
        type: p.type,
        bytes: p.bytes,
        width: p.width,
        height: p.height,
        source: "artifact",
        kind: "artifact",
        derivedFrom: [result.sourceId],
        producedBy: "split",
        addedAt: Date.now(),
        previewVersion: 0,
      };
    });
    // New artifacts only: the source keeps its blob and its split settings.
    store.getState().addArtifacts(added);
    for (const f of added) void makePreview(f.id);
    return added.map((f) => f.id);
  }

  /** Register a locally converted raster in the same lifecycle as other workspace outputs. */
  function addConvertedImage(blob: Blob, name: string, width: number, height: number, producedBy: "pdf-to-jpg" | "svg-to-png"): FileId {
    if (disposed || leaving || (blob.type !== "image/png" && blob.type !== "image/jpeg")) throw new Error("Conversion output is unavailable");
    const id = newId();
    registry.put(id, blob);
    store.getState().addArtifact({
      id, name: safeFileName(name, `converted.${blob.type === "image/png" ? "png" : "jpg"}`),
      type: blob.type, bytes: blob.size, width, height,
      source: "artifact", kind: "artifact", producedBy, addedAt: Date.now(), previewVersion: 0,
    });
    void makePreview(id);
    return id;
  }

  function selected(assetId?: FileId) {
    const id = assetId ?? store.getState().selectedId;
    const file = id ? store.getState().files[id] : undefined;
    const blob = id ? registry.blob(id) : undefined;
    if (!id || !file || !blob) throw Object.assign(new Error("No image selected"), { code: "DECODE_FAILED" });
    return { id, file, blob };
  }

  function registerArtifact(blob: Blob, baseName: string, sourceId: FileId, producedBy: "safe-share" | "blur" | "metadata", width: number, height: number): FileId {
    const id = newId();
    const mime = blob.type as ImageMime;
    registry.put(id, blob);
    store.getState().addArtifact({
      id,
      name: baseName,
      type: mime,
      bytes: blob.size,
      width,
      height,
      source: "artifact",
      kind: "artifact",
      derivedFrom: [sourceId],
      producedBy,
      addedAt: Date.now(),
      previewVersion: 0,
    });
    void makePreview(id);
    return id;
  }

  async function renderSafeShareArtifact(assetId?: FileId, pendingReview = false): Promise<WorkspaceSafeShareResult> {
    const { id: sourceId, blob } = selected(assetId);
    const s = store.getState();
    const operations = s.redaction.byAsset[sourceId] ?? [];
    if (!operations.length) throw Object.assign(new Error("Add a redaction first"), { code: "REDACTION_INVALID_RECT" });
    const { format, quality } = s.exportSettings;
    const jobId = `redaction:${Date.now()}`;
    job(jobId, "redaction-export", "running", 0);
    try {
      const result = caps.offscreenCanvas
        ? await broker.run("image", "redaction.export", { image: blob, operations, format, quality }, { onProgress: (p) => job(jobId, "redaction-export", "running", p) })
        : await (await import("@/core/redaction/render")).renderSafeShare(blob, operations, {
            format,
            quality,
            createCanvas: (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h }),
            onProgress: (p) => job(jobId, "redaction-export", "running", p),
          });
      if (result.width * result.height > 16_000_000) broker.release("image");
      const mime: ImageMime = format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : "image/webp";
      if (!isSafeShareVerified(result.verification) || result.blob.type !== mime) throw new RedactionError("REDACTION_VERIFY_FAILED");
      if (!store.getState().files[sourceId] || registry.blob(sourceId) !== blob) throw new RedactionError("REDACTION_VERIFY_FAILED", "Source is no longer available");
      const producedBy = s.activeTool === "blur" ? "blur" : "safe-share";
      const { blob: outputBlob, ...rest } = result;
      const artifactId = pendingReview ? newId() : registerArtifact(outputBlob, `safe-copy.${EXT[mime]}`, sourceId, producedBy, result.width, result.height);
      if (pendingReview) {
        registry.put(artifactId, outputBlob);
        pendingSafeShares.set(artifactId, { sourceId, blob: outputBlob, width: result.width, height: result.height, mime, producedBy, verification: Object.freeze({ ...result.verification }) });
      }
      job(jobId, "redaction-export", "done", 1);
      return { ...rest, id: artifactId, bytes: outputBlob.size };
    } catch (e) {
      const code = codeOf(e);
      job(jobId, "redaction-export", "failed", null, code);
      throw Object.assign(new Error(code), { code });
    }
  }

  const exportSafeShare = (assetId?: FileId) => renderSafeShareArtifact(assetId);
  const prepareSafeShare = (assetId?: FileId) => renderSafeShareArtifact(assetId, true);
  function verifiedPreparedSafeShare(id: FileId) {
    const pending = pendingSafeShares.get(id);
    if (!pending || !store.getState().files[pending.sourceId] || registry.blob(id) !== pending.blob ||
      pending.blob.type !== pending.mime || !isSafeShareVerified(pending.verification)) throw new RedactionError("REDACTION_VERIFY_FAILED");
    return pending;
  }
  async function extractPreparedSafeShareText(id: FileId): Promise<OcrResult> {
    const pending = verifiedPreparedSafeShare(id);
    try {
      const { result } = await extractTextFromBlob(id, pending.blob, store.getState().ocr.language, true, false);
      verifiedPreparedSafeShare(id); // The copy may have been discarded while OCR was running.
      return result;
    } finally {
      ocrResults.removeAsset(id);
    }
  }
  function publishPreparedSafeShare(id: FileId): FileId {
    const pending = verifiedPreparedSafeShare(id);
    if (activeOcrAsset === id) throw new RedactionError("REDACTION_VERIFY_FAILED", "The optional text check is still running");
    store.getState().addArtifact({
      id, name: `safe-copy.${EXT[pending.mime]}`, type: pending.mime, bytes: pending.blob.size,
      width: pending.width, height: pending.height, source: "artifact", kind: "artifact",
      derivedFrom: [pending.sourceId], producedBy: pending.producedBy, addedAt: Date.now(), previewVersion: 0,
    });
    pendingSafeShares.delete(id);
    void makePreview(id);
    return id;
  }
  function discardPreparedSafeShare(id: FileId): void {
    if (!pendingSafeShares.has(id)) return;
    if (activeOcrAsset === id) void cancelOcr(id, true).catch(() => undefined);
    pendingSafeShares.delete(id);
    ocrResults.removeAsset(id);
    registry.remove(id);
  }

  async function inspectMetadata(assetId?: FileId): Promise<MetadataInspectRun> {
    const { id, file, blob } = selected(assetId);
    job(`metadata:${id}`, "metadata-inspect", "running", 0);
    try {
      const result = await broker.run("image", "metadata.inspect", { image: blob, name: file.name, type: file.type });
      job(`metadata:${id}`, "metadata-inspect", "done", 1);
      return result;
    } catch (e) {
      job(`metadata:${id}`, "metadata-inspect", "failed", null, codeOf(e));
      throw e;
    }
  }

  async function cleanMetadata(assetId?: FileId): Promise<WorkspaceMetadataCleanResult> {
    const { id: sourceId, file, blob } = selected(assetId);
    const jobId = `metadata-clean:${sourceId}`;
    job(jobId, "metadata-clean", "running", 0);
    try {
      const result = await broker.run("image", "metadata.clean", { image: blob, name: file.name, type: file.type });
      let artifactId: FileId | null = null;
      if (result.changed && result.output) {
        const cleanName = `privacy-clean-${file.name.replace(/^privacy-clean-/, "")}`;
        artifactId = registerArtifact(result.output, cleanName, sourceId, "metadata", result.before.width, result.before.height);
      }
      job(jobId, "metadata-clean", "done", 1);
      return { ...result, artifactId };
    } catch (e) {
      job(jobId, "metadata-clean", "failed", null, codeOf(e));
      throw e;
    }
  }

  async function extractText(assetId?: FileId, language?: OcrLanguageChoice, silent = false): Promise<WorkspaceOcrResult> {
    const { id, blob } = selected(assetId);
    return extractTextFromBlob(id, blob, language ?? store.getState().ocr.language, silent);
  }

  function extractTextFromBlob(id: FileId, blob: Blob, choice: OcrLanguageChoice, silent: boolean, recordState = true): Promise<WorkspaceOcrResult> {
    return track(() => extractTextFromBlobNow(id, blob, choice, silent, recordState));
  }

  async function extractTextFromBlobNow(id: FileId, blob: Blob, choice: OcrLanguageChoice, silent: boolean, recordState: boolean): Promise<WorkspaceOcrResult> {
    const requestRevision = ++ocrRequestRevision;
    if (activeOcrAsset) await cancelOcr(activeOcrAsset, true, false);
    if (requestRevision !== ocrRequestRevision || disposed) throw Object.assign(new Error("OCR_CANCELLED"), { code: "OCR_CANCELLED" });
    activeOcrAsset = id;
    const abort = new AbortController();
    activeOcrAbort = abort;
    if (recordState) store.getState().beginOcr(id, choice);
    const jobId = `ocr:${id}`;
    job(jobId, "ocr", "running", 0);
    // Avoid retaining another large WASM heap while Tesseract is active.
    broker.release("vision");
    broker.release("document");
    let service: OcrService | null = null;
    const ownsRequest = () => activeOcrAbort === abort;
    const ownsSource = () => !recordState || registry.blob(id) === blob;
    const pageSignal = pageAbort.signal;
    const onPageAbort = () => { abort.abort(); if (ownsRequest()) void service?.cancel(); };
    if (disposed || leaving || pageSignal.aborted) abort.abort();
    else pageSignal.addEventListener("abort", onPageAbort, { once: true });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      service = await getOcrService();
      if (abort.signal.aborted || !ownsRequest() || !ownsSource()) throw Object.assign(new Error("OCR_CANCELLED"), { code: "OCR_CANCELLED" });
      timer = setTimeout(() => {
        if (!ownsRequest() || abort.signal.aborted) return;
        timedOut = true;
        abort.abort();
        void service?.cancel();
      }, opts.ocrTimeoutMs ?? DEFAULT_OCR_CONFIG.recognitionTimeoutMs);
      const result = await service.extract(blob, {
        languages: ocrLanguages(choice),
        preprocessing: "auto",
        readingOrder: "auto",
        strips: "auto",
        signal: abort.signal,
        onProgress: (progress, stage) => {
          if (!ownsRequest() || abort.signal.aborted || !ownsSource()) return;
          if (recordState) store.getState().setOcrProgress(id, progress, stage);
          job(jobId, "ocr", "running", progress);
        },
      });
      if (timedOut) throw Object.assign(new Error("OCR_TIMEOUT"), { code: "OCR_TIMEOUT" });
      if (abort.signal.aborted || !ownsRequest() || !ownsSource()) throw Object.assign(new Error("OCR_CANCELLED"), { code: "OCR_CANCELLED" });
      const resultId = ocrResults.put(id, result);
      if (recordState) store.getState().completeOcr(id, {
        resultId,
        editedText: result.editedText,
        confidence: result.confidence,
        durationMs: result.timings.totalMs,
      });
      job(jobId, "ocr", "done", 1);
      if (!silent) toast(hasOcrText(result) ? { type: "success", message: "Text extracted", description: "Review the text before copying or downloading it." } : { type: "info", message: "No text found", description: "Try another language or a clearer copy. Your screenshot is unchanged." });
      return { resultId, result };
    } catch (error) {
      // A retired request must not mutate a retry's state or retain results for removed inputs.
      if (!ownsRequest() || !ownsSource()) throw Object.assign(new Error("OCR_CANCELLED"), { code: "OCR_CANCELLED" });
      const code = timedOut ? "OCR_TIMEOUT" : codeOf(error);
      if (code === "OCR_CANCELLED") {
        if (recordState) store.getState().cancelOcr(id);
        job(jobId, "ocr", "cancelled", null, code);
      } else {
        if (recordState) store.getState().failOcr(id, code);
        job(jobId, "ocr", "failed", null, code);
        if (!silent) toast({ type: "error", message: "Extraction failed", description: "Could not extract text from this image." });
      }
      throw Object.assign(new Error(code), { code });
    } finally {
      if (timer) clearTimeout(timer);
      pageSignal.removeEventListener("abort", onPageAbort);
      if (ownsRequest()) {
        activeOcrAsset = null;
        activeOcrAbort = null;
      }
    }
  }

  async function cancelOcr(assetId?: FileId, silent = false, invalidatePending = true): Promise<void> {
    if (invalidatePending) ocrRequestRevision++;
    const id = assetId ?? activeOcrAsset;
    if (!id) return;
    store.getState().cancelOcr(id);
    job(`ocr:${id}`, "ocr", "cancelled", null, "OCR_CANCELLED");
    if (activeOcrAsset === id) {
      activeOcrAbort?.abort();
      activeOcrAbort = null;
      activeOcrAsset = null;
      await ocrService?.cancel();
    }
    if (!silent) toast({ type: "info", message: "Text extraction cancelled" });
  }

  async function extractStructuredData(assetId: FileId, options: StructuredAnalysisOptions = {}, onStage?: (stage: string) => void): Promise<StructuredExtraction> {
    activeStructuredAbort?.abort();
    const abort = new AbortController();
    activeStructuredAbort = abort;
    const jobId = `structured:${assetId}`;
    job(jobId, "structured-data", "running", null);
    try {
      onStage?.("Reading screenshot…");
      let ocr = ocrResults.forAsset(assetId);
      if (!ocr) {
        onStage?.("Extracting text…");
        ocr = (await extractText(assetId, undefined, true)).result;
      }
      if (abort.signal.aborted) throw Object.assign(new Error("STRUCTURED_CANCELLED"), { code: "STRUCTURED_CANCELLED" });
      onStage?.("Analyzing structure…");
      await Promise.resolve();
      // Loaded here, not at module scope: the table/key-value analyser and the privacy
      // detector tables are tens of KB that every workspace page would otherwise carry.
      const { analyseStructuredData } = await import("@/core/structured-data/analyse");
      const result = analyseStructuredData({ assetId, ocr, options });
      if (abort.signal.aborted) throw Object.assign(new Error("STRUCTURED_CANCELLED"), { code: "STRUCTURED_CANCELLED" });
      onStage?.("Preparing data…");
      structuredResults.put(result);
      job(jobId, "structured-data", "done", 1);
      return result;
    } catch (error) {
      const code = abort.signal.aborted ? "STRUCTURED_CANCELLED" : codeOf(error);
      job(jobId, "structured-data", code === "STRUCTURED_CANCELLED" ? "cancelled" : "failed", null, code);
      throw Object.assign(new Error(code), { code });
    } finally {
      if (activeStructuredAbort === abort) activeStructuredAbort = null;
    }
  }

  function cancelStructuredData(): void {
    activeStructuredAbort?.abort();
    activeStructuredAbort = null;
    if (activeOcrAsset) void cancelOcr(activeOcrAsset, true);
  }

  async function scanPrivacy(assetId: FileId, config: PrivacyScanConfig, onStage?: (stage: string) => void): Promise<PrivacyScanResult> {
    const selectedAsset = selected(assetId);
    activePrivacyAbort?.abort();
    const abort = new AbortController();
    activePrivacyAbort = abort;
    const jobId = `privacy-scan:${assetId}`;
    job(jobId, "privacy-scan", "running", null);
    try {
      onStage?.("Reading screenshot…");
      const textRequested = config.enabledCategories.some((category) => category !== "visual") || Boolean(config.detectPlateText && config.enabledCategories.includes("visual"));
      let ocr = textRequested ? ocrResults.forAsset(assetId) : undefined;
      if (textRequested && !ocr) {
        onStage?.("Extracting text…");
        ocr = (await extractText(assetId, undefined, true)).result;
      }
      if (abort.signal.aborted) throw Object.assign(new Error("PRIVACY_SCAN_CANCELLED"), { code: "PRIVACY_SCAN_CANCELLED" });
      let faces: import("@/core/privacy/face-detect").FaceSuggestion[] = [];
      let faceSupport: PrivacyScanResult["faceSupport"] = "not-requested";
      if (config.detectFaces && config.enabledCategories.includes("visual")) {
        const { faceScanAllowed } = await import("@/core/privacy/face-detect");
        const deviceMemoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
        if (!faceScanAllowed(selectedAsset.file, deviceMemoryGb)) faceSupport = "too-large";
        else if (!caps.offscreenCanvas) faceSupport = "unavailable";
        else {
          onStage?.("Finding faces…");
          try {
            faces = await broker.run("privacy", "privacy.faces", { image: selectedAsset.blob }, { signal: abort.signal, onProgress: (_progress, stage) => { if (stage) onStage?.(stage); } });
            faceSupport = "supported";
          } catch {
            if (abort.signal.aborted) throw Object.assign(new Error("PRIVACY_SCAN_CANCELLED"), { code: "PRIVACY_SCAN_CANCELLED" });
            faceSupport = "unavailable";
          } finally { broker.release("privacy"); }
        }
      }
      if (abort.signal.aborted) throw Object.assign(new Error("PRIVACY_SCAN_CANCELLED"), { code: "PRIVACY_SCAN_CANCELLED" });
      const { buildPrivacyScan } = await import("@/core/privacy/scan");
      const result = await buildPrivacyScan({ assetId, blob: selectedAsset.blob, ocr, faces, faceSupport, config, signal: abort.signal, onStage });
      privacyScans.put(result);
      job(jobId, "privacy-scan", "done", 1);
      toast({ type: "success", message: "Privacy scan complete", description: `${result.findings.length} possible sensitive item${result.findings.length === 1 ? "" : "s"} found. Review before redacting.` });
      return result;
    } catch (error) {
      const code = (error as { code?: string }).code ?? "PRIVACY_SCAN_FAILED";
      if (code === "PRIVACY_SCAN_CANCELLED" || abort.signal.aborted) {
        job(jobId, "privacy-scan", "cancelled", null, "PRIVACY_SCAN_CANCELLED");
        toast({ type: "info", message: "Detection cancelled" });
        throw Object.assign(new Error("PRIVACY_SCAN_CANCELLED"), { code: "PRIVACY_SCAN_CANCELLED" });
      }
      job(jobId, "privacy-scan", "failed", null, "PRIVACY_SCAN_FAILED");
      toast({ type: "error", message: "Scan failed", description: "Shotexa could not complete the local privacy scan. Manual redaction is still available." });
      throw Object.assign(new Error("PRIVACY_SCAN_FAILED"), { code: "PRIVACY_SCAN_FAILED" });
    } finally { if (activePrivacyAbort === abort) activePrivacyAbort = null; }
  }

  async function cancelPrivacyScan(): Promise<void> {
    const active = activePrivacyAbort;
    active?.abort();
    activePrivacyAbort = null;
    if (active) { broker.release("privacy"); await cancelOcr(undefined, true); }
  }

  async function removeBackground(assetId: FileId, onStage?: (stage: string) => void, silent = false, method: "object" | "ink" = "object"): Promise<SegmentationResult> {
    const { file, blob } = selected(assetId);
    activeBackgroundAbort?.abort();
    const abort = new AbortController();
    activeBackgroundAbort = abort;
    const jobId = `background:${assetId}`;
    job(jobId, "background-remove", "running", null);
    try {
      const result = caps.offscreenCanvas
        ? await broker.run("background", "background.remove", { image: blob, method }, { signal: abort.signal, onProgress: (_progress, stage) => { if (stage) onStage?.(stage); } })
        : method === "ink"
          ? await (await import("@/core/background-removal/ink")).segmentInk(blob, abort.signal, (width, height) => Object.assign(document.createElement("canvas"), { width, height }))
          : await (await import("@/core/background-removal/inference")).segmentImage(blob, location.origin, abort.signal, onStage, (width, height) => Object.assign(document.createElement("canvas"), { width, height }));
      if (abort.signal.aborted) throw Object.assign(new Error("BACKGROUND_CANCELLED"), { code: "BACKGROUND_CANCELLED" });
      backgroundMasks.put(assetId, result);
      // Avoid retaining the inference heap beside a later full-resolution canvas on large files.
      if (file.width * file.height > 16_000_000) broker.release("background");
      job(jobId, "background-remove", "done", 1);
      if (!silent) toast({ type: "success", message: "Background removed", description: "Review the mask and refine any edges before exporting." });
      return result;
    } catch (error) {
      const code = abort.signal.aborted ? "BACKGROUND_CANCELLED" : codeOf(error);
      job(jobId, "background-remove", code === "BACKGROUND_CANCELLED" || code === "CANCELLED" ? "cancelled" : "failed", null, code);
      if (!silent && code !== "BACKGROUND_CANCELLED" && code !== "CANCELLED") toast({ type: "error", message: code === "BACKGROUND_MODEL_LOAD_FAILED" ? "Model unavailable" : "Background removal failed", description: "The image stayed on this device. Retry, or check that this browser can run local WebAssembly." });
      throw Object.assign(new Error(code), { code });
    } finally { if (activeBackgroundAbort === abort) activeBackgroundAbort = null; }
  }

  function cancelBackgroundRemoval(): void {
    activeBackgroundAbort?.abort();
    activeBackgroundAbort = null;
    // Inference itself is not cooperatively interruptible; terminate the isolated worker.
    broker.release("background");
    toast({ type: "info", message: "Background removal cancelled" });
  }

  async function renderBackgroundAsset(assetId: FileId, settings: BackgroundRemovalSettings, format: OutputFormat, quality: number, backgroundImage?: Blob, signal = new AbortController().signal): Promise<BackgroundRemovalRenderResult> {
    const { file, blob } = selected(assetId);
    const mask = backgroundMasks.materialize(assetId);
    const entry = backgroundMasks.get(assetId);
    if (!mask || !entry) throw Object.assign(new Error("BACKGROUND_MASK_MISSING"), { code: "BACKGROUND_MASK_MISSING" });
    const input = { image: blob, source: { width: file.width, height: file.height }, mask: { data: mask, width: entry.result.width, height: entry.result.height, matte: entry.result.matte }, settings, format, quality, backgroundImage };
    return caps.offscreenCanvas
      ? broker.run("background", "background.export", input, { signal })
      : (await import("@/core/background-removal/render")).renderRemovedBackground(blob, { ...input, createCanvas: (width, height) => Object.assign(document.createElement("canvas"), { width, height }), signal });
  }

  async function exportRemovedBackground(assetId: FileId, settings: BackgroundRemovalSettings = DEFAULT_BACKGROUND_REMOVAL, backgroundImage?: Blob): Promise<EditorExportResult> {
    const { file } = selected(assetId);
    const { format, quality } = store.getState().exportSettings;
    const abort = new AbortController();
    const jobId = `background-export:${assetId}:${Date.now()}`;
    job(jobId, "background-export", "running", null);
    try {
      const result = await renderBackgroundAsset(assetId, settings, format, quality, backgroundImage, abort.signal);
      const type: ImageMime = format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : "image/webp";
      const id = newId();
      const extension = format === "jpeg" ? "jpg" : format;
      registry.put(id, result.blob);
      store.getState().addArtifact({ id, name: `background-removed-${file.name.replace(/\.[^.]+$/, "")}.${extension}`, type, bytes: result.blob.size, width: result.width, height: result.height, source: "artifact", kind: "artifact", derivedFrom: [assetId], producedBy: "remove-background", addedAt: Date.now(), previewVersion: 0 });
      // Keep the reviewed source active so its mask, completion summary and refinement
      // history remain visible. Continue With explicitly selects the derived artifact.
      store.getState().select(assetId);
      job(jobId, "background-export", "done", 1);
      void makePreview(id);
      if (result.width * result.height > 16_000_000) broker.release("background");
      toast({ type: "success", message: "Export ready", description: `${result.width} × ${result.height} ${format.toUpperCase()} created locally.` });
      return { id, width: result.width, height: result.height, bytes: result.blob.size, sourceId: assetId };
    } catch (error) {
      const code = codeOf(error);
      job(jobId, "background-export", "failed", null, code);
      throw Object.assign(new Error(code), { code });
    }
  }

  async function planPdf(inputIds: FileId[], setup: PageSetup, smart: boolean, edits: Record<FileId, PdfBreakEdit> = {}): Promise<PaginationPlan> {
    if (!inputIds.length) throw Object.assign(new Error("No screenshots selected"), { code: "PDF_INVALID_BREAKS" });
    const engine = await getPdfEngine();
    const s = store.getState();
    const files = inputIds.map((id) => s.files[id]).filter((f): f is WorkspaceFile => !!f);
    if (files.length !== inputIds.length) throw Object.assign(new Error("Missing screenshot"), { code: "PDF_DECODE_FAILED" });
    const missing = smart ? files.filter((f) => !pdfAnalyses.hasSignals(f.id)) : [];
    if (missing.length) {
      const abort = new AbortController();
      activePdfAbort?.abort();
      activePdfAbort = abort;
      store.getState().setPdfStatus("analysing", 0, "Finding better page breaks");
      job("pdf:analyse", "pdf-analyse", "running", 0);
      try {
        const analysed = await engine.analyse(
          missing.map((f) => registry.blob(f.id)!),
          {
            signal: abort.signal,
            onProgress: (progress, stage) => {
              if (activePdfAbort !== abort) return;
              store.getState().setPdfStatus("analysing", progress, stage ?? "Finding better page breaks");
              job("pdf:analyse", "pdf-analyse", "running", progress);
            },
          },
        );
        if (abort.signal.aborted || activePdfAbort !== abort) {
          throw Object.assign(new Error("PDF_CANCELLED"), { code: "PDF_CANCELLED" });
        }
        missing.forEach((file, index) => pdfAnalyses.put(file.id, analysed.images[index]));
        job("pdf:analyse", "pdf-analyse", "done", 1);
      } catch (error) {
        const code = codeOf(error);
        const cancelled = code === "PDF_CANCELLED" || code === "CANCELLED";
        if (activePdfAbort === abort) {
          store.getState().setPdfStatus(cancelled ? "cancelled" : "failed", null, undefined, cancelled ? "PDF_CANCELLED" : code);
          job("pdf:analyse", "pdf-analyse", cancelled ? "cancelled" : "failed", null, code);
        }
        throw Object.assign(new Error(code), { code });
      } finally {
        if (activePdfAbort === abort) activePdfAbort = null;
      }
    }

    const analysedSet: AnalysedSet = {
      images: files.map((file) => {
        const cached = pdfAnalyses.get(file.id);
        return cached ?? { width: file.width, height: file.height, safeYs: [] };
      }),
      decodeMs: 0,
      signalMs: 0,
      wallMs: 0,
      path: "worker",
      decoders: [],
    };
    return engine.plan(analysedSet, setup, smart ? "visual" : "fixed", {
      manual: files.map((file) => edits[file.id]?.manual),
      frozen: files.map((file) => edits[file.id]?.frozen),
    });
  }

  function pdfSafeYs(assetId: FileId): number[] {
    return pdfAnalyses.get(assetId)?.safeYs ?? [];
  }

  async function runPdfExport(inputIds: FileId[], plan: PaginationPlan, searchable: boolean): Promise<WorkspacePdfResult> {
    if (!inputIds.length || !plan.pages.length) throw Object.assign(new Error("No PDF pages"), { code: "PDF_INVALID_BREAKS" });
    const engine = await getPdfEngine();
    const s = store.getState();
    const blobs = inputIds.map((id) => registry.blob(id));
    if (blobs.some((blob) => !blob)) throw Object.assign(new Error("Missing screenshot"), { code: "PDF_DECODE_FAILED" });
    const abort = new AbortController();
    activePdfAbort?.abort();
    activePdfAbort = abort;
    store.getState().setPdfStatus("exporting", 0, "Preparing pages");
    job("pdf:export", "pdf-export", "running", 0);
    broker.release("vision");
    try {
      const searchableText = searchable
        ? inputIds.map((id, imageIndex) => {
            const result = ocrResults.forAsset(id);
            const state = s.ocr.byAsset[id];
            if (!result || state?.status !== "done" || state.language !== s.ocr.language || ocrResults.get(state.resultId) !== result) throw Object.assign(new Error("OCR required"), { code: "PDF_OCR_REQUIRED" });
            return searchableSourceFromResult(imageIndex, result, id);
          })
        : undefined;
      if (searchableText && !searchableText.some((source) => source.lines.length > 0)) throw Object.assign(new Error("No searchable OCR text"), { code: "PDF_OCR_EMPTY" });
      const result = await engine.createPdf(
        {
          images: blobs as Blob[],
          plan,
          imageFormat: s.pdf.imageFormat,
          jpegQuality: s.pdf.jpegQuality,
          title: searchable ? "Shotexa searchable screenshots" : "Shotexa screenshots",
          searchableText,
        },
        {
          signal: abort.signal,
          onProgress: (progress, stage) => {
            if (activePdfAbort !== abort) return;
            store.getState().setPdfStatus("exporting", progress, stage ?? "Creating PDF");
            job("pdf:export", "pdf-export", "running", progress);
          },
        },
      );
      if (abort.signal.aborted || activePdfAbort !== abort) {
        throw Object.assign(new Error("PDF_CANCELLED"), { code: "PDF_CANCELLED" });
      }
      const id = newId();
      const document: WorkspaceDocument = {
        id,
        name: searchable ? "shotexa-searchable-screenshots.pdf" : "shotexa-screenshots.pdf",
        type: "application/pdf",
        bytes: result.blob.size,
        pageCount: result.pages,
        sourceIds: [...inputIds],
        producedBy: searchable ? "searchable-pdf" : "pdf",
        addedAt: Date.now(),
      };
      registry.put(id, result.blob);
      store.getState().addDocument(document);
      store.getState().setPdfStatus("ready", 1, "PDF ready");
      job("pdf:export", "pdf-export", "done", 1);
      toast({ type: "success", message: "PDF generated", description: document.name });
      return { id, blob: result.blob, bytes: result.blob.size, pages: result.pages, ms: result.ms, path: result.path };
    } catch (error) {
      const code = codeOf(error);
      const cancelled = code === "PDF_CANCELLED" || code === "CANCELLED";
      if (activePdfAbort === abort) {
        store.getState().setPdfStatus(cancelled ? "cancelled" : "failed", null, undefined, cancelled ? "PDF_CANCELLED" : code);
        job("pdf:export", "pdf-export", cancelled ? "cancelled" : "failed", null, code);
        if (!cancelled) toast({ type: "error", message: "PDF generation failed", description: "Could not create the PDF file." });
      }
      throw Object.assign(new Error(code), { code });
    } finally {
      if (activePdfAbort === abort) activePdfAbort = null;
    }
  }

  const exportPdf = (inputIds: FileId[], plan: PaginationPlan) => runPdfExport(inputIds, plan, false);
  const exportSearchablePdf = (inputIds: FileId[], plan: PaginationPlan) => runPdfExport(inputIds, plan, true);

  function cancelPdf(): void {
    activePdfAbort?.abort();
    activePdfAbort = null;
    // A hard stop bounds cancellation latency during an uninterruptible image decode.
    pdfEngine?.dispose();
    pdfEngine = null;
    store.getState().setPdfStatus("cancelled", null, undefined, "PDF_CANCELLED");
    toast({ type: "info", message: "PDF generation cancelled" });
  }

  // Reordering changes which screenshots are adjacent: re-run the (cheap) overlap hint.
  const unsubscribe = store.subscribe((next, prev) => {
    if (next.order !== prev.order && next.overlapHint.status === "idle") void checkOverlap();
  });

  return {
    store,
    registry,
    ocrResults,
    structuredResults,
    privacyScans,
    pdfAnalyses,
    batchResults,
    backgroundMasks,
    compareAnalyses,
    broker,
    caps,
    ingest,
    ingestResource: (file) => ingest([file], "picker", {}, true),
    cancelPreviews,
    retryPreviews: async () => { await Promise.all(Object.keys(store.getState().files).map((id) => makePreview(id))); await checkOverlap(); },
    removeFile: (id) => {
      proxies.delete(id);
      store.getState().removeFile(id);
      void checkOverlap();
    },
    clear: () => {
      inputGeneration++;
      cancelPreviews();
      encodeSession.clear();
      proxies.clear();
      store.getState().clear();
      for (const id of pendingSafeShares.keys()) registry.remove(id);
      pendingSafeShares.clear();
    },
    analyseStitch,
    cancelStitch,
    stitchPlan,
    exportStitch,
    exportCombine,
    exportEdit,
    exportAnnotated,
    exportSplit,
    addSplitPieces,
    exportBeautified,
    exportCompare,
    cancelCompareExport,
    alignCompare,
    resetCompareAlignment,
    analyseCompareText,
    cancelCompareText,
    publishCompareAnalysis,
    measureCompare,
    exportCompareReport,
    encodeAsset,
    compareEncodeFormats,
    cancelEncode: () => encodeSession.cancel(),
    saveEncoded,
    hasTransparency,
    exportSafeShare,
    prepareSafeShare,
    extractPreparedSafeShareText,
    publishPreparedSafeShare,
    discardPreparedSafeShare,
    inspectMetadata,
    cleanMetadata,
    extractText,
    cancelOcr,
    extractStructuredData,
    cancelStructuredData,
    scanPrivacy,
    cancelPrivacyScan,
    removeBackground,
    cancelBackgroundRemoval,
    exportRemovedBackground,
    planPdf,
    pdfSafeYs,
    exportPdf,
    exportSearchablePdf,
    cancelPdf,
    runBatch,
    cancelBatch,
    resetBatch,
    retryBatchFailed,
    createBatchZip: zipBatch,
    addBatchResults,
    addConvertedImage,
    dispose() {
      disposed = true;
      cancelStitch();
      cancelCompareExport();
      activeCompareReportAbort?.abort();
      inputGeneration++;
      cancelPreviews();
      pageAbort.abort();
      pageEvents?.removeEventListener("pagehide", onPageHide);
      pageEvents?.removeEventListener("pageshow", onPageShow);
      pageEvents?.removeEventListener("beforeunload", onBeforeUnload);
      pageEvents?.removeEventListener("pointerdown", onStillHere);
      pageEvents?.removeEventListener("keydown", onStillHere);
      unsubscribe();
      encodeSession.clear();
      store.getState().clear();
      pendingSafeShares.clear();
      registry.clear();
      ocrResults.clear();
      structuredResults.clear();
      privacyScans.clear();
      pdfAnalyses.clear();
      batchResults.clear();
      backgroundMasks.clear();
      compareAnalyses.clear();
      void ocrService?.dispose();
      ocrService = null;
      pdfEngine?.dispose();
      pdfEngine = null;
      broker.dispose();
    },
  };
}

/** Save a Blob that is not (yet) in the registry, e.g. a rendered Split piece. */
export function downloadBlob(blob: Blob, name: string, silent = false): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (!silent) toast({ type: "success", message: "Download started", description: name });
  // The click has started the download; give the browser a moment before releasing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Save several files one after another. Spaced out because browsers drop or block bursts of
 * programmatic downloads; some ask once to allow "multiple downloads" from the page.
 */
export async function downloadBlobs(files: { blob: Blob; name: string }[], gapMs = 250): Promise<void> {
  toast({ type: "success", message: "Download started", description: `Downloading ${files.length} files...` });
  for (let i = 0; i < files.length; i++) {
    downloadBlob(files[i].blob, files[i].name, true);
    if (i < files.length - 1) await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
}

/** Save a registry asset through a temporary link; the object URL is owned by the registry. */
export function downloadAsset(runtime: WorkspaceRuntime, id: FileId, silent = false): void {
  const state = runtime.store.getState();
  const f = state.files[id] ?? state.documents[id];
  const url = runtime.registry.objectUrl(id);
  if (!f || !url) return;
  const a = document.createElement("a");
  a.href = url;
  a.download = f.name;
  if ("kind" in f && f.kind === "original") a.dataset.analyticsIgnore = "true";
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (!silent) {
    if (f.bytes > 15 * 1024 * 1024) {
      toast({ type: "info", message: "Download started", description: `${f.name} is ${(f.bytes / (1024 * 1024)).toFixed(1)} MB and may take a moment.` });
    } else {
      toast({ type: "success", message: "Download started", description: f.name });
    }
  }
}
