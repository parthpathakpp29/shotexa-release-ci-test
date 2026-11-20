import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assemblePdf, type EncodedPage } from "@/core/pdf/render-pdf";
import { buildPlan } from "@/core/pdf/plan";
import { DEFAULT_PAGINATION_CONFIG } from "@/core/pdf/config";
import { buildPdfTextRuns, type SearchableTextSource } from "@/core/pdf/searchable-text";
import type { PageSetup } from "@/core/pdf/types";
import { ocrAccuracy } from "@/tests/helpers/ocr-quality";

const fixture = "src/tests/fixtures/ocr-quality/unicode-layout";
const truth = JSON.parse(readFileSync(`${fixture}/expected.json`, "utf8")) as { width: number; height: number; lines: { text: string; box: number[]; words: { text: string; box: number[] }[] }[] };
const box = (b: number[]) => ({ x: b[0], y: b[1], w: b[2], h: b[3] });
const source: SearchableTextSource = { imageIndex: 0, language: "eng+hin", lines: truth.lines.map(l => ({ text: l.text, bbox: box(l.box), words: l.words.map(w => ({ text: w.text, bbox: box(w.box) })) })) };

describe("searchable PDF logical Unicode and word positioning", () => {
  it("preserves a recognized Hindi word separator even when the ink boxes are close", async () => {
    const setup: PageSetup = { paper: "fit", orientation: "portrait", marginPt: 0 };
    const plan = buildPlan([{ width: truth.width, height: truth.height }], setup, "fixed", DEFAULT_PAGINATION_CONFIG);
    const page: EncodedPage = { slice: plan.pages[0], imageWidth: truth.width, imageHeight: truth.height, format: "png", tiles: [{ y0: 0, y1: truth.height, bytes: new Uint8Array(readFileSync(`${fixture}/image.png`)) }] };
    const text: SearchableTextSource = { imageIndex: 0, language: "hin", lines: [{ text: "दिन शुभ", bbox: { x: 30, y: 40, w: 69, h: 22 }, words: [{ text: "दिन", bbox: { x: 30, y: 40, w: 34, h: 22 } }, { text: "शुभ", bbox: { x: 65, y: 40, w: 34, h: 22 } }] }] };
    const blob = await assemblePdf([page], 1, { setup, imageFormat: "png", searchableText: [text], searchableFontBytes: new Uint8Array(readFileSync("src/assets/fonts/Hind-Regular.ttf")) });
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), useWorkerFetch: false }).promise;
    try {
      const content = await (await doc.getPage(1)).getTextContent();
      expect(content.items.map(item => "str" in item ? item.str : "").join("")).toBe("दिन शुभ");
    } finally { await doc.destroy(); }
  });
  it("round-trips exact Hindi combining marks, ligatures and mixed lines in reading order", async () => {
    const setup: PageSetup = { paper: "fit", orientation: "portrait", marginPt: 0 };
    const plan = buildPlan([{ width: truth.width, height: truth.height }], setup, "fixed", DEFAULT_PAGINATION_CONFIG);
    const page: EncodedPage = { slice: plan.pages[0], imageWidth: truth.width, imageHeight: truth.height, format: "png", tiles: [{ y0: 0, y1: truth.height, bytes: new Uint8Array(readFileSync(`${fixture}/image.png`)) }] };
    const blob = await assemblePdf([page], 1, { setup, imageFormat: "png", searchableText: [source], searchableFontBytes: new Uint8Array(readFileSync("src/assets/fonts/Hind-Regular.ttf")) });
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const viewer = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), useWorkerFetch: false }).promise;
    try {
      const content = await (await viewer.getPage(1)).getTextContent();
      const items = content.items.filter((i): i is import("pdfjs-dist/types/src/display/api").TextItem => "str" in i);
      const text = items.map(i => i.str + (i.hasEOL ? "\n" : "")).join("");
      expect(ocrAccuracy(truth.lines.map(l => l.text).join("\n"), text)).toMatchObject({ cer: 0, wer: 0 });
      for (const line of truth.lines) expect(text.normalize("NFC")).toContain(line.text.normalize("NFC"));
      const first = items.find(i => i.str.trim());
      const runs = buildPdfTextRuns(plan, [source]);
      expect(first?.transform[4]).toBeCloseTo(runs[0].x, 3);
      expect(first?.width).toBeCloseTo(runs[0].w, 3);
      const words = truth.lines.reduce((n, l) => n + l.words.length, 0);
      expect(runs.filter(run => !run.separator)).toHaveLength(words);
      expect(runs.filter(run => run.separator)).toHaveLength(words - truth.lines.length);
    } finally { await viewer.destroy(); }
  });
  it("retains wide table gaps instead of stretching an entire line uniformly", () => {
    const setup: PageSetup = { paper: "fit", orientation: "portrait", marginPt: 0 };
    const plan = buildPlan([{ width: 1000, height: 200 }], setup, "fixed", DEFAULT_PAGINATION_CONFIG);
    const runs = buildPdfTextRuns(plan, [{ imageIndex: 0, language: "eng", lines: [{ text: "Item Total", bbox: { x: 10, y: 20, w: 900, h: 20 }, words: [{ text: "Item", bbox: { x: 10, y: 21, w: 40, h: 18 } }, { text: "Total", bbox: { x: 850, y: 18, w: 50, h: 22 } }] }] }]);
    const words = runs.filter(run => !run.separator);
    expect(words[1].x - words[0].x).toBeCloseTo(840 * 0.75);
    expect(words[1].y).toBe(words[0].y);
    expect(runs[1]).toMatchObject({ separator: true, text: " ", x: 50 * 0.75, w: 800 * 0.75 });
  });
});
