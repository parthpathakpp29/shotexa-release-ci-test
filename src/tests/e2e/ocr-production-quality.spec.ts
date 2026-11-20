import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { ocrAccuracy } from "../helpers/ocr-quality";

const receipt = join(process.cwd(), "src/tests/fixtures/ocr/receipt/image.png");
const tiny = join(process.cwd(), "src/tests/fixtures/ocr/phone-tiny-1x/image.png");
const boundary = join(process.cwd(), "src/tests/fixtures/ocr-quality/strip-boundaries/image.png");
const white = new PNG({ width: 300, height: 300 }); white.data.fill(255);
const blank = { name: "blank.png", mimeType: "image/png", buffer: PNG.sync.write(white) };

test.describe.configure({ timeout: 300_000 });
test.use({ viewport: { width: 1440, height: 960 } });

async function open(page: Page, path: string, files: string | string[] | (typeof blank)[]) {
  await page.goto(path); await page.getByTestId("file-input").setInputFiles(files);
}
async function pdfText(page: Page) {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 180_000 }), page.getByTestId("export").click()]);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const viewer = await pdfjs.getDocument({ data: new Uint8Array(readFileSync((await download.path())!)), useWorkerFetch: false }).promise;
  try {
    const text: string[] = [];
    for (let i = 1; i <= viewer.numPages; i++) text.push((await (await viewer.getPage(i)).getTextContent()).items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "").join(""));
    return text.join("\n");
  } finally { await viewer.destroy(); }
}

test("tiny text and every long-strip boundary retain useful recognition and order", async ({ page }) => {
  for (const file of [tiny, boundary]) {
    await open(page, "/screenshot-to-text", file);
    await page.getByTestId("extract-text").click();
    const editor = page.getByTestId("ocr-result-text"); await expect(editor).toBeVisible({ timeout: 180_000 });
    const text = await editor.inputValue(), truth = readFileSync(join(file, "../expected.txt"), "utf8");
    const score = ocrAccuracy(truth, text);
    expect(score.cer).not.toBeNull(); expect(score.cer!).toBeLessThan(0.03);
    if (file === boundary) {
      const lines = truth.trim().split(/\r?\n/);
      let previous = -1;
      for (const line of lines) { const index = text.indexOf(line); expect(index).toBeGreaterThan(previous); previous = index; expect(text.split(line)).toHaveLength(2); }
    }
  }
});

test("cold model-load cancellation is immediate and a fresh retry succeeds", async ({ page }) => {
  let release!: () => void;
  let handled!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const finished = new Promise<void>(resolve => { handled = resolve; });
  const pattern = "**/vendor/tessdata/**/eng.traineddata.gz";
  await page.route(pattern, async route => {
    if (route.request().method() === "HEAD") {
      await gate;
      try { await route.fulfill({ status: 200 }); } finally { handled(); }
    }
    else await route.continue();
  });
  await open(page, "/screenshot-to-text", receipt);
  const request = page.waitForRequest(r => /eng\.traineddata/.test(r.url()) && r.method() === "HEAD");
  await page.getByTestId("extract-text").click(); await request;
  await page.getByTestId("cancel-ocr").click();
  await expect(page.getByTestId("ocr-cancelled")).toBeVisible();
  release(); await finished; await page.unroute(pattern);
  await page.getByTestId("extract-text").click();
  await expect(page.getByTestId("ocr-result-text")).toHaveValue(/Corner Cafe/, { timeout: 180_000 });
  await expect(page.getByTestId("ocr-cancelled")).toBeHidden();
});

test("empty recognition is honest, manual text stays TXT-only, and mixed PDF warns about image-only pages", async ({ page }) => {
  await page.goto("/screenshot-to-text"); await page.getByTestId("file-input").setInputFiles(blank);
  await page.getByTestId("extract-text").click(); await expect(page.getByTestId("ocr-empty")).toBeVisible({ timeout: 180_000 });
  await page.getByTestId("ocr-result-text").fill("Manual text without geometry");
  await expect(page.getByTestId("ocr-result").getByRole("link", { name: /Searchable PDF/ })).toHaveCount(0);
  await open(page, "/screenshot-to-searchable-pdf", [blank]);
  await page.getByTestId("extract-for-searchable-pdf").click();
  await expect(page.getByTestId("pdf-empty-ocr")).toContainText("No readable text", { timeout: 180_000 });
  await expect(page.getByTestId("export")).toBeDisabled();
  await page.getByTestId("file-input").setInputFiles(receipt);
  await expect(page.getByTestId("file-item")).toHaveCount(2);
  await page.getByTestId("extract-for-searchable-pdf").click();
  await expect(page.getByTestId("pdf-empty-ocr")).toContainText("will remain image-only", { timeout: 180_000 });
  expect(await pdfText(page)).toContain("Corner Cafe");
});

test("changing PDF OCR language re-extracts an existing result instead of silently reusing it", async ({ page }) => {
  await open(page, "/screenshot-to-text", receipt);
  await page.getByTestId("extract-text").click();
  await expect(page.getByTestId("ocr-result-text")).toBeVisible({ timeout: 180_000 });
  await page.getByTestId("ocr-result").getByRole("link", { name: /Searchable PDF/ }).click();
  await expect(page.getByText("Text layer ready").first()).toBeVisible();
  const models: string[] = []; page.on("request", request => { if (/hin\.traineddata/.test(request.url())) models.push(request.url()); });
  await page.getByRole("radio", { name: "English + Hindi", exact: true }).click();
  await expect(page.getByTestId("export")).toBeDisabled();
  await page.getByTestId("extract-for-searchable-pdf").click();
  await expect(page.getByText("Text layer ready").first()).toBeVisible({ timeout: 180_000 });
  expect(models.length).toBeGreaterThan(0);
  expect(await pdfText(page)).toContain("Corner Cafe");
});

test("PDF extraction preserves later successes after one OCR failure and can retry the failed image", async ({ page }) => {
  await page.addInitScript(() => {
    let failed = false;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
        const packet = message as { action?: string; workerId?: string; jobId?: string };
        if (!failed && packet.action === "recognize") {
          failed = true;
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { workerId: packet.workerId, jobId: packet.jobId, action: "recognize", status: "reject", data: "Synthetic recognition failure" } })));
          return;
        }
        super.postMessage(message, transfer as Transferable[]);
      }
    };
  });
  const receiptPayload = { name: "receipt.png", mimeType: "image/png", buffer: readFileSync(receipt) };
  await open(page, "/screenshot-to-searchable-pdf", [blank, receiptPayload]);
  await page.getByTestId("extract-for-searchable-pdf").click();
  const readiness = page.getByRole("heading", { name: "Searchable text", exact: true }).locator("xpath=ancestor::section[1]");
  await expect(readiness.getByText("OCR failed", { exact: true })).toBeVisible({ timeout: 180_000 });
  await expect(readiness.getByText("Ready", { exact: true })).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("export")).toBeDisabled();
  await page.getByTestId("extract-for-searchable-pdf").click();
  await expect(page.getByTestId("pdf-empty-ocr")).toContainText("will remain image-only", { timeout: 180_000 });
  expect(await pdfText(page)).toContain("Corner Cafe");
});
