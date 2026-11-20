import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PDFDocument, rgb } from "pdf-lib";
import { PNG } from "pngjs";
import { unzipSync } from "fflate";

async function pdf(pages: number, width = 1200, height = 1800) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([width, height]).drawRectangle({ x: 0, y: 0, width, height, color: rgb((i % 3) / 3, .2, .7) });
  return { name: `pages-${pages}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) };
}
async function open(page: Page, pages: number, width?: number, height?: number) {
  await page.goto("/pdf-to-png");
  await page.getByLabel("PDF file", { exact: true }).setInputFiles(await pdf(pages, width, height));
  await expect(page.getByText(`pages-${pages}.pdf · ${pages} pages`, { exact: true })).toBeVisible();
  await expect(page.getByLabel("PDF file", { exact: true })).toBeEnabled();
}
async function jump(page: Page, number: number) {
  await page.getByLabel("Go to page", { exact: true }).fill(String(number)); await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(page.getByAltText(`Preview of PDF page ${number}`, { exact: true })).toBeVisible();
}
test.describe.configure({ timeout: 180_000 });

for (const count of [1, 10, 40, 80]) test(`${count} larger pages: lazy thumbnails, preserved selection, native PNG dimensions and pixels`, async ({ page }, testInfo) => {
  if (count >= 40) await page.setViewportSize({ width: 390, height: 844 });
  await open(page, count);
  const grid = page.getByTestId("pdf-page-grid");
  await expect(grid.getByRole("checkbox", { checked: true })).toHaveCount(count);
  await expect(page.getByAltText("Preview of PDF page 1", { exact: true })).toBeVisible();
  expect(Number(await grid.getAttribute("data-cached"))).toBeLessThanOrEqual(24);
  if (count > 24) { await expect(page.getByAltText(`Preview of PDF page ${count}`, { exact: true })).toHaveCount(0); await expect(page.getByTestId("pdf-export-plan")).toContainText("safe batch size"); }
  await jump(page, count);
  if (count === 80) await page.screenshot({ path: testInfo.outputPath("pdf-80-mobile.png") });
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.getByRole("checkbox", { name: `Page ${count}`, exact: true }).check();
  await page.getByRole("combobox", { name: "Resolution", exact: true }).selectOption("1");
  await expect(page.getByTestId("pdf-export-plan")).toContainText("Final encoded file size is unknown");
  await expect(page.getByRole("button", { name: "Convert", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Convert", exact: true }).click();
  const output = page.getByRole("region", { name: "Conversion results" });
  await expect(output.getByRole("heading", { name: "Results (1/1)" })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), output.getByRole("button", { name: "Download", exact: true }).click()]);
  expect(download.suggestedFilename()).toBe(`pages-${count}-page-${String(count).padStart(2, "0")}.png`);
  const pixels = PNG.sync.read(readFileSync((await download.path())!)); expect([pixels.width, pixels.height]).toEqual([1200, 1800]);
  expect(Math.abs(pixels.data[0] - Math.round(((count - 1) % 3) / 3 * 255))).toBeLessThanOrEqual(2);
  expect(pixels.data[3]).toBe(255);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("scrolling an 80-page PDF bounds and releases preview URLs; page selection survives", async ({ page }) => {
  await page.addInitScript(() => {
    const live = new Set<string>(), create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL); let peak = 0;
    URL.createObjectURL = (blob) => { const url = create(blob); live.add(url); peak = Math.max(peak, live.size); return url; };
    URL.revokeObjectURL = (url) => { live.delete(url); revoke(url); };
    (window as unknown as { urls(): { live: number; peak: number } }).urls = () => ({ live: live.size, peak });
  });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message)); page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await open(page, 80, 200, 100);
  for (const n of [1, 20, 40, 60, 80, 1]) { await jump(page, n); expect(Number(await page.getByTestId("pdf-page-grid").getAttribute("data-cached"))).toBeLessThanOrEqual(24); }
  await expect(page.getByTestId("pdf-page-grid").getByRole("checkbox", { checked: true })).toHaveCount(80);
  expect(await page.evaluate(() => (window as unknown as { urls(): { peak: number } }).urls().peak)).toBeLessThanOrEqual(24);
  await page.getByRole("button", { name: "Pause previews", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume previews", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Resume previews", exact: true }).click();
  await page.getByRole("banner").getByRole("link", { name: "Shotexa home", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { urls(): { live: number } }).urls().live)).toBe(0);
  expect(errors).toEqual([]);
});

test("page selection order, high resolution, ZIP estimate and downloaded bytes agree", async ({ page }) => {
  await open(page, 10, 200, 100);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.getByRole("checkbox", { name: "Page 8", exact: true }).check();
  await page.getByRole("checkbox", { name: "Page 2", exact: true }).check();
  await page.getByRole("combobox", { name: "Resolution", exact: true }).selectOption("3");
  await page.getByRole("button", { name: "Convert", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Results (2/2)" })).toBeVisible();
  await expect(page.getByTestId("pdf-zip-plan")).toContainText("ZIP size:");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download ZIP", exact: true }).click()]);
  const files = unzipSync(readFileSync((await download.path())!)); expect(Object.keys(files)).toEqual(["pages-10-page-02.png", "pages-10-page-08.png"]);
  for (const bytes of Object.values(files)) { const image = PNG.sync.read(Buffer.from(bytes)); expect([image.width, image.height]).toEqual([600, 300]); }
  await page.getByRole("combobox", { name: "Output format", exact: true }).selectOption("jpg");
  await page.getByRole("button", { name: "Convert", exact: true }).click();
  await expect(page.getByText("pages-10-page-02.jpg", { exact: true })).toBeVisible();
  const [jpegDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download ZIP", exact: true }).click()]);
  const jpegs = unzipSync(readFileSync((await jpegDownload.path())!));
  expect(Object.keys(jpegs)).toEqual(["pages-10-page-02.jpg", "pages-10-page-08.jpg"]);
  const bytes = jpegs["pages-10-page-02.jpg"]; expect([...bytes.subarray(0, 3)]).toEqual([255, 216, 255]);
  const jpeg = await page.evaluate(async (data) => { const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: "image/jpeg" })); const canvas = document.createElement("canvas"); try { canvas.width = bitmap.width; canvas.height = bitmap.height; const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0); return { width: bitmap.width, height: bitmap.height, pixel: [...context.getImageData(0, 0, 1, 1).data] }; } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; } }, [...bytes]);
  expect([jpeg.width, jpeg.height]).toEqual([600, 300]); expect(jpeg.pixel[3]).toBe(255); expect(Math.abs(jpeg.pixel[0] - 85)).toBeLessThanOrEqual(5);
});

test("cancellation retains a completed page and retry processes only uncompleted pages", async ({ page }) => {
  await page.addInitScript(() => {
    const encode = HTMLCanvasElement.prototype.toBlob; let outputs = 0;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      if (this.width >= 900) outputs++;
      if (this.width >= 900 && outputs === 2) { (window as unknown as { release(): void }).release = () => encode.call(this, callback, type, quality); return; }
      return encode.call(this, callback, type, quality);
    };
    (window as unknown as { encodes(): number }).encodes = () => outputs;
  });
  await open(page, 3, 900, 600); await page.getByRole("combobox", { name: "Resolution", exact: true }).selectOption("1");
  await page.getByRole("button", { name: "Convert", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { encodes(): number }).encodes())).toBe(2);
  await page.getByRole("button", { name: "Cancel conversion", exact: true }).click();
  await page.evaluate(() => (window as unknown as { release(): void }).release());
  await expect(page.getByRole("heading", { name: "Results (1/3)" })).toBeVisible();
  await page.getByRole("button", { name: "Retry failed pages", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Results (3/3)" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { encodes(): number }).encodes())).toBe(4);
});

test("opening cancellation can retry without a stale document; oversized pages fail before export", async ({ page }) => {
  await page.addInitScript(() => {
    const read = File.prototype.arrayBuffer; let hold = true;
    File.prototype.arrayBuffer = function () {
      if (hold && this.name.endsWith(".pdf")) { hold = false; return new Promise((resolve, reject) => { (window as unknown as { releaseRead(): void }).releaseRead = () => { void read.call(this).then(resolve, reject); }; }); }
      return read.call(this);
    };
  });
  await page.goto("/pdf-to-png"); await page.getByLabel("PDF file", { exact: true }).setInputFiles(await pdf(10, 200, 100));
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseRead?: unknown }).releaseRead)).toBe("function");
  await page.getByRole("button", { name: "Cancel conversion", exact: true }).click(); await page.evaluate(() => (window as unknown as { releaseRead(): void }).releaseRead());
  await expect(page.getByRole("button", { name: "Retry opening PDF", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Retry opening PDF", exact: true }).click();
  await expect(page.getByText("pages-10.pdf · 10 pages", { exact: true })).toBeVisible();
  await page.getByLabel("PDF file", { exact: true }).setInputFiles(await pdf(1, 10000, 10000));
  await expect(page.getByTestId("pdf-export-plan")).toContainText("too large"); await expect(page.getByRole("button", { name: "Convert", exact: true })).toBeDisabled();
});
