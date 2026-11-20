import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

type Gate = { hold: boolean; starts: number; finished: number; release: (() => void)[]; holdHeader: boolean; releaseHeader?: () => void; live: Set<string> };
type TestWindow = Window & { previewTest: Gate };
test.use({ viewport: { width: 1440, height: 960 } });
test.describe.configure({ timeout: 180000 });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("shotexa.analytics-consent.v1", "rejected");
    localStorage.setItem("shotexa.vercel-analytics-opt-out.v1", "true");
    const gate: Gate = { hold: false, starts: 0, finished: 0, release: [], holdHeader: false, live: new Set() };
    (window as unknown as TestWindow).previewTest = gate;
    const WorkerBase = window.Worker;
    window.Worker = class extends WorkerBase {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", (event) => { if (event.data.jobId?.startsWith("image.preview:") && event.data.type !== "PROGRESS") gate.finished++; });
      }
      postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
        const packet = message as { type?: string; op?: string };
        const send = () => super.postMessage(message, Array.isArray(transfer) ? { transfer } : transfer);
        if (packet.type === "RUN" && packet.op === "image.preview") { gate.starts++; if (gate.hold) { gate.release.push(send); return; } }
        send();
      }
    };
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      if (gate.holdHeader && this.size === 16) {
        gate.holdHeader = false;
        return new Promise<ArrayBuffer>((resolve, reject) => { gate.releaseHeader = () => { void read.call(this).then(resolve, reject); }; });
      }
      return read.call(this);
    };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const url = create(blob); gate.live.add(url); return url; };
    URL.revokeObjectURL = (url) => { gate.live.delete(url); revoke(url); };
  });
});
function fixture(name: string, width = 240, height = 320) {
  const image = new PNG({ width, height }); image.data.fill(255);
  for (let y = 0; y < height; y += 40) image.data.fill(100, y * width * 4, (y * width + Math.min(100, width)) * 4);
  return { name, mimeType: "image/png", buffer: PNG.sync.write(image) };
}
const small = fixture("first.png");
async function gate(page: Page, settings: { hold?: boolean; holdHeader?: boolean }) { await page.evaluate((settings) => Object.assign((window as unknown as TestWindow).previewTest, settings), settings); }
async function release(page: Page) { await page.evaluate(() => { const gate = (window as unknown as TestWindow).previewTest; gate.hold = false; gate.release.splice(0).forEach((send) => send()); }); }
async function ready(page: Page, count: number) {
  await expect(page.getByTestId("file-item")).toHaveCount(count);
  await expect.poll(() => page.getByTestId("file-item").locator("canvas").evaluateAll((canvases) => canvases.every((node) => (node as HTMLCanvasElement).width > 1)), { timeout: 120000 }).toBe(true);
}

test("accepted files and order are available while previews are held; cancel and retry stay serial", async ({ page }) => {
  await page.goto("/"); await gate(page, { hold: true });
  await page.getByTestId("file-input").setInputFiles([small, { ...small, name: "second.png" }, { ...small, name: "third.png" }]);
  await expect(page.getByTestId("file-item")).toHaveCount(3);
  await expect(page.getByTestId("file-loading-feedback")).toContainText("3 screenshots added to workspace");
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).previewTest.starts)).toBe(1);
  expect(await page.getByTestId("file-item").locator("canvas").evaluateAll((nodes) => nodes.every((node) => (node as HTMLCanvasElement).width * (node as HTMLCanvasElement).height === 1))).toBe(true);
  await page.getByRole("button", { name: "Move first.png down" }).click();
  await expect(page.getByTestId("file-item").first()).toContainText("second.png");
  await page.getByRole("button", { name: "Cancel file processing" }).click();
  await release(page);
  await expect(page.getByTestId("file-loading-feedback")).toContainText("stopped");
  await page.getByRole("button", { name: "Retry previews", exact: true }).click();
  await ready(page, 3);
  expect(await page.evaluate(() => (window as unknown as TestWindow).previewTest.starts)).toBe(4);
  await page.evaluate(() => { window.dispatchEvent(new Event("beforeunload")); window.dispatchEvent(new Event("pointerdown")); });
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).previewTest.starts)).toBe(4);
  await expect(page.getByTestId("file-item").first()).toContainText("second.png");
});

test("three tall 12 MP uploads retain dimensions and bound visible thumbnail canvases on mobile", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/compress-screenshot");
  const large = fixture("large-one.png", 1200, 10000);
  await page.getByTestId("file-input").setInputFiles([large, { ...large, name: "large-two.png" }, { ...large, name: "large-three.png" }]);
  await page.getByRole("button", { name: /^Files/ }).click();
  await ready(page, 3);
  const canvases = await page.getByTestId("file-item").locator("canvas").evaluateAll((nodes) => nodes.map((node) => { const canvas = node as HTMLCanvasElement; return { width: canvas.width, height: canvas.height, alpha: canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data[3] }; }));
  expect(canvases).toHaveLength(3);
  expect(canvases.every((canvas) => canvas.width <= 1024 && canvas.height <= 192 && canvas.alpha > 0)).toBe(true);
  const dialog = page.getByRole("dialog", { name: "Screenshots" });
  await expect(dialog.getByTestId("file-item").first()).toContainText("1200 × 10000");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("mobile-large-uploads.png") });
});

test("unsafe header dimensions are kept as originals but refused before automatic preview decoding", async ({ page }) => {
  const bytes = new Uint8Array(45), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, 10000); view.setUint32(20, 10000); bytes.set([73, 69, 78, 68], 37);
  await page.goto("/compress-screenshot");
  await page.getByTestId("file-input").setInputFiles({ name: "unsafe-dimensions.png", mimeType: "image/png", buffer: Buffer.from(bytes) });
  await expect(page.getByTestId("file-item")).toHaveCount(1);
  await expect(page.getByTestId("file-loading-feedback")).toContainText("automatic preview memory budget");
  await expect(page.getByTestId("encode-issue")).toContainText("too large");
  await expect(page.getByTestId("encode-check")).toBeDisabled();
  await expect(page.getByTestId("file-item")).toContainText("10000 × 10000");
  expect(await page.getByTestId("file-item").locator("canvas").evaluate((node) => (node as HTMLCanvasElement).width * (node as HTMLCanvasElement).height)).toBe(1);
});

test("a large batch pauses at the aggregate preview budget and resumes after removing unused files", async ({ page }) => {
  await page.goto("/");
  const image = fixture("0.png", 1170, 2532);
  await page.getByTestId("file-input").setInputFiles(Array.from({ length: 29 }, (_, i) => ({ ...image, name: `${i}.png` })));
  await expect(page.getByTestId("file-item")).toHaveCount(29);
  await expect(page.getByTestId("file-loading-feedback")).toContainText("preview memory budget is full", { timeout: 120000 });
  const before = await page.evaluate(() => (window as unknown as TestWindow).previewTest.starts);
  expect(before).toBeLessThan(29);
  // Leave eight files, which fits even the existing 128 MiB low-memory policy.
  for (let i = 0; i < 21; i++) await page.getByRole("button", { name: `Remove ${i}.png`, exact: true }).click();
  await page.getByRole("button", { name: "Retry previews", exact: true }).click();
  await ready(page, 8);
  await expect(page.getByTestId("file-item").last()).toContainText("1170 × 2532");
});

test("a corrupt recognized container has a retryable preview error and can be removed", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("file-input").setInputFiles({ name: "corrupt.png", mimeType: "image/png", buffer: small.buffer.subarray(0, 33) });
  await expect(page.getByTestId("file-item")).toContainText("Preview unavailable");
  await page.getByRole("button", { name: "Retry previews", exact: true }).click();
  await expect(page.getByTestId("file-item")).toContainText("Preview unavailable");
  await page.getByRole("button", { name: "Remove corrupt.png" }).click();
  await expect(page.getByTestId("file-item")).toHaveCount(0);
});

test("PNG, JPEG and WebP EXIF previews preserve this browser's display geometry", async ({ page }) => {
  for (const [folder, name, type] of [["jpeg", "orientation-6.jpg", "image/jpeg"], ["png", "exif-orientation-6.png", "image/png"], ["webp", "exif-orientation-6.webp", "image/webp"], ["jpeg", "large-metadata.jpg", "image/jpeg"]]) {
    await page.goto("/");
    let bytes = readFileSync(join(process.cwd(), "src/tests/fixtures/metadata", folder, name === "large-metadata.jpg" ? "clean.jpg" : name));
    if (name === "large-metadata.jpg") {
      const segment = Buffer.alloc(65537); segment.set([255, 226, 255, 255]);
      bytes = Buffer.concat([bytes.subarray(0, 2), ...Array.from({ length: 20 }, () => segment), bytes.subarray(2)]);
    }
    const expected = await page.evaluate(async ({ data, type }) => { const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type })); const size = [bitmap.width, bitmap.height]; bitmap.close(); return size; }, { data: bytes.toString("base64"), type });
    await page.getByTestId("file-input").setInputFiles({ name, mimeType: type, buffer: bytes });
    await ready(page, 1);
    await expect(page.getByTestId("file-item")).toContainText(`${expected[0]} × ${expected[1]}`);
  }
});

test("removing a held preview cannot restore the file and releases its original URL", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/compress-screenshot"); await gate(page, { hold: true });
  await page.getByTestId("file-input").setInputFiles(small);
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).previewTest.starts)).toBe(1);
  await page.getByRole("button", { name: "Remove first.png" }).click();
  await release(page);
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).previewTest.finished)).toBe(1);
  await expect(page.getByTestId("file-item")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).previewTest.live.size)).toBe(0);
  expect(errors).toEqual([]);
});

test("a later picker request cannot overtake an earlier slow header", async ({ page }) => {
  await page.goto("/"); await gate(page, { holdHeader: true });
  await page.getByTestId("file-input").setInputFiles(small);
  await expect.poll(() => page.evaluate(() => !!(window as unknown as TestWindow).previewTest.releaseHeader)).toBe(true);
  await page.getByTestId("file-input").setInputFiles({ ...small, name: "second.png" });
  await expect(page.getByTestId("file-item")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as TestWindow).previewTest.releaseHeader!());
  await ready(page, 2);
  await expect(page.getByTestId("file-item").nth(0)).toContainText("first.png");
  await expect(page.getByTestId("file-item").nth(1)).toContainText("second.png");
});

test("cancel during validation adds nothing late and the next upload still works", async ({ page }) => {
  await page.goto("/"); await gate(page, { holdHeader: true });
  await page.getByTestId("file-input").setInputFiles(small);
  await expect.poll(() => page.evaluate(() => !!(window as unknown as TestWindow).previewTest.releaseHeader)).toBe(true);
  await page.getByRole("button", { name: "Cancel file processing" }).click();
  await page.evaluate(() => (window as unknown as TestWindow).previewTest.releaseHeader!());
  await expect(page.getByTestId("file-item")).toHaveCount(0);
  await page.getByTestId("file-input").setInputFiles({ ...small, name: "next.png" });
  await ready(page, 1);
  await expect(page.getByTestId("file-item")).toContainText("next.png");
});
