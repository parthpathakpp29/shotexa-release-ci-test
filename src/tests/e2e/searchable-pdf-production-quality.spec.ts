import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeOcrText } from "../helpers/ocr-quality";

const fixtures = join(process.cwd(), "src/tests/fixtures/ocr");
test.describe.configure({ timeout: 300_000 });
test.use({ viewport: { width: 1440, height: 960 } });

async function extractAndDownload(page: Page, files: string[], hindi = false) {
  await page.goto("/screenshot-to-searchable-pdf");
  await page.getByTestId("file-input").setInputFiles(files);
  await expect(page.getByTestId("pdf-preview")).toBeVisible({ timeout: 120_000 });
  if (hindi) await page.getByRole("radio", { name: "English + Hindi", exact: true }).click();
  await page.getByTestId("extract-for-searchable-pdf").click();
  await expect(page.getByText("Text layer ready", { exact: true }).first()).toBeVisible({ timeout: 240_000 });
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 180_000 }), page.getByTestId("export").click()]);
  expect(download.suggestedFilename()).toBe("shotexa-searchable-screenshots.pdf");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync((await download.path())!)), useWorkerFetch: false }).promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      pages.push(content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "").join(""));
    }
    return pages;
  } finally { await doc.destroy(); }
}

test("Hindi and mixed-language PDFs preserve real OCR text in logical copy order", async ({ page }) => {
  const pages = await extractAndDownload(page, [join(fixtures, "hindi-article/image.png"), join(fixtures, "chat-mixed-en-hi/image.png")], true);
  expect(pages.length).toBeGreaterThanOrEqual(2);
  const text = normalizeOcrText(pages.join("\n"));
  const hindi = normalizeOcrText(readFileSync(join(fixtures, "hindi-article/expected.txt"), "utf8"));
  expect(text).toContain(hindi);
  // Other lines in the mixed fixture have measured OCR comma/digit misses. This
  // ground-truth phrase is recognized reliably; this test isolates PDF encoding.
  expect(text).toContain("Payment successful हो गया, धन्यवाद!");
  expect(text.indexOf(hindi)).toBeLessThan(text.indexOf("Project group"));
});

test("long searchable PDF retains text across the existing pagination in both engines", async ({ page }) => {
  const pages = await extractAndDownload(page, [join(fixtures, "long-1080x5000/image.png")]);
  expect(pages.length).toBeGreaterThan(3);
  expect(pages.filter(text => text.trim().length > 0).length).toBeGreaterThan(2);
  expect(pages.join("\n").length).toBeGreaterThan(500);
  expect(pages[0]).toContain("Project group");
});
