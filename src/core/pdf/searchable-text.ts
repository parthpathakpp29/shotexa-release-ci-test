/**
 * Searchable-PDF text-layer preparation.
 *
 * The text here always comes from the original structured OCR result. User-edited OCR
 * text is intentionally excluded: edited prose has no reliable relationship to the OCR
 * geometry and remains the source for Copy/TXT only.
 */
import { orderLines } from "@/core/ocr/normalize";
import type { BBox, OcrResult } from "@/core/ocr/types";
import { imageBoxToPdfPage } from "./coords";
import { pageGeometry } from "./geometry";
import type { PaginationPlan } from "./types";

export interface SearchableTextLine {
  text: string;
  bbox: BBox;
  /** Original word boxes retain table gaps and proportional-font placement. */
  words?: { text: string; bbox: BBox }[];
}

export interface SearchableTextSource {
  imageIndex: number;
  assetId?: string;
  language: string;
  lines: SearchableTextLine[];
}

export interface PdfTextRun {
  pageIndex: number;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  language: string;
  /** Explicit word boundary: readers must not have to infer spaces from ink gaps. */
  separator?: boolean;
}

const validBox = (box: BBox) => Object.values(box).every(Number.isFinite) && box.w > 0 && box.h > 0;

/** Preserve the reading order chosen by Phase 2B without copying unrelated OCR metadata. */
export function searchableSourceFromResult(imageIndex: number, result: OcrResult, assetId?: string): SearchableTextSource {
  return {
    imageIndex,
    assetId,
    language: result.language,
    lines: orderLines(result.blocks, result.readingOrder)
      .filter((line) => line.text.trim().length > 0 && validBox(line.bbox))
      .map((line) => ({
        text: line.text.normalize("NFC"), bbox: { ...line.bbox },
        words: line.words.filter((word) => word.text.trim() && validBox(word.bbox)).map((word) => ({ text: word.text.normalize("NFC"), bbox: { ...word.bbox } })),
      })),
  };
}

/** Map original-image OCR geometry to the exact page slices used by the visual PDF. */
export function buildPdfTextRuns(plan: PaginationPlan, sources: SearchableTextSource[]): PdfTextRun[] {
  const runs: PdfTextRun[] = [];
  for (const source of sources) {
    const image = plan.images[source.imageIndex];
    if (!image) continue;
    const geometry = pageGeometry(plan.setup, image.width, image.height);
    for (const line of source.lines) {
      const words = line.words?.length ? line.words : [line];
      for (const [index, word] of words.entries()) {
        // Keep one baseline per line; fit each word to its own horizontal OCR geometry.
        const box = { x: word.bbox.x, w: word.bbox.w, y: line.bbox.y, h: line.bbox.h };
        const rect = imageBoxToPdfPage(box, plan.pages, source.imageIndex, geometry, plan.setup.marginPt);
        if (!rect || !word.text.trim()) continue;
        runs.push({ ...rect, text: word.text, language: source.language });
        const next = words[index + 1];
        if (next) {
          // All words share the line's page/baseline. Reuse its scale instead of
          // searching the page slices again just to position a separator.
          const scale = rect.w / word.bbox.w;
          runs.push({
            ...rect, x: rect.x + rect.w, w: Math.max(0.1, (next.bbox.x - word.bbox.x - word.bbox.w) * scale),
            text: " ", language: source.language, separator: true,
          });
        }
      }
    }
  }
  return runs;
}

