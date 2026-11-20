import { describe, expect, it } from "vitest";
import { ocrAccuracy } from "@/tests/helpers/ocr-quality";
import { hasOcrText } from "@/core/ocr/normalize";
import type { OcrResult } from "@/core/ocr/types";

describe("OCR quality measurement and empty results", () => {
  it("measures Unicode code points, preserves errors and folds only whitespace/NFC", () => {
    expect(ocrAccuracy("Hello\nनमस्ते 😀", "Hello नमस्ते 😀").cer).toBe(0);
    expect(ocrAccuracy("a😀", "a").characterErrors).toBe(1);
    expect(ocrAccuracy("Hello, world", "hello world")).toMatchObject({ characterErrors: 2, wordErrors: 1 });
    expect(ocrAccuracy("", "unexpected").cer).toBeNull();
  });
  it("requires recognized text with usable finite geometry", () => {
    const result = (text: string, w = 10) => ({ blocks: [{ paragraphs: [{ lines: [{ text, bbox: { x: 0, y: 0, w, h: 10 } }] }] }] }) as OcrResult;
    expect(hasOcrText(undefined)).toBe(false);
    expect(hasOcrText(result("   "))).toBe(false);
    expect(hasOcrText(result("manual", NaN))).toBe(false);
    expect(hasOcrText(result("नमस्ते"))).toBe(true);
  });
});
