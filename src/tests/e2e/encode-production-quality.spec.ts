import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

type Gate = { requests: { op: string; existing: number }[]; domEncodes: number; hold: boolean; held: boolean; release?: () => void };
type TestWindow = Window & { compressorTest: Gate };
test.use({ viewport: { width: 1440, height: 960 } });
test.describe.configure({ timeout: 180_000 });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("shotexa.analytics-consent.v1", "rejected");
    localStorage.setItem("shotexa.vercel-analytics-opt-out.v1", "true");
    const gate: Gate = { requests: [], domEncodes: 0, hold: false, held: false };
    (window as unknown as TestWindow).compressorTest = gate;
    const nativePost = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      const packet = message as { type?: string; op?: string; input?: { existing?: unknown[] } };
      const send = () => nativePost.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
      if (packet.type === "RUN" && (packet.op === "image.encode" || packet.op === "image.compareFormats")) {
        gate.requests.push({ op: packet.op, existing: packet.input?.existing?.length ?? 0 });
        if (gate.hold && packet.op === "image.encode") {
          gate.hold = false; gate.held = true;
          gate.release = () => { gate.held = false; send(); };
          return;
        }
      }
      send();
    };
    const nativeToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      gate.domEncodes++;
      const send = () => nativeToBlob.call(this, callback, type, quality);
      if (gate.hold) {
        gate.hold = false; gate.held = true;
        gate.release = () => { gate.held = false; send(); };
        return;
      }
      send();
    };
  });
});

async function makeImage(page: Page, type = "image/png", width = 800, height = 600, kind: "detail" | "noise" | "alpha" = "detail") {
  const base64 = await page.evaluate(async ({ type, width, height, kind }) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    if (kind === "alpha") { ctx.fillStyle = "rgb(220,40,40)"; ctx.fillRect(width / 2, 0, width / 2, height); }
    else if (kind === "noise") {
      const data = ctx.createImageData(width, height); let seed = 1234567;
      for (let i = 0; i < data.data.length; i += 4) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        data.data[i] = seed & 255; data.data[i + 1] = (seed >>> 8) & 255; data.data[i + 2] = (seed >>> 16) & 255; data.data[i + 3] = 255;
      }
      ctx.putImageData(data, 0, 0);
    } else {
      ctx.fillStyle = "#f7f1e3"; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#132b46"; ctx.font = "14px monospace";
      for (let y = 24; y < Math.min(height, 600); y += 24) ctx.fillText(`Screenshot detail ${y}: ABC 0123 <> []`, 12, y);
      ctx.fillStyle = "#23685b"; ctx.fillRect(Math.floor(width * .7), 0, Math.ceil(width * .3), height);
    }
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((result) => resolve(result!), type, 0.95));
    if (blob.type !== type) throw new Error(`Fixture encoder does not support ${type}`);
    const bytes = new Uint8Array(await blob.arrayBuffer()); let text = "";
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    canvas.width = 0; canvas.height = 0;
    return btoa(text);
  }, { type, width, height, kind });
  return { name: `fixture.${type === "image/jpeg" ? "jpg" : type.split("/")[1]}`, mimeType: type, buffer: Buffer.from(base64, "base64") };
}

async function open(page: Page, type = "image/png", width = 800, height = 600, kind: "detail" | "noise" | "alpha" = "detail") {
  await page.goto("/compress-screenshot");
  const file = await makeImage(page, type, width, height, kind);
  await page.evaluate(() => { const gate = (window as unknown as TestWindow).compressorTest; gate.requests = []; gate.domEncodes = 0; });
  await page.getByTestId("file-input").setInputFiles(file);
  await expect(page.getByTestId("encode-workspace")).toBeVisible({ timeout: 30_000 });
  return file;
}
const format = (page: Page, name: string) => page.getByRole("radiogroup", { name: "Output format" }).getByRole("radio", { name });
async function check(page: Page) {
  await page.getByTestId("encode-check").click();
  await expect(page.getByTestId("encode-comparison")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Settings changed since this result.", { exact: true })).toHaveCount(0);
}
async function counters(page: Page) { return page.evaluate(() => { const gate = (window as unknown as TestWindow).compressorTest; return { requests: gate.requests, domEncodes: gate.domEncodes }; }); }
async function download(page: Page, trigger = page.getByTestId("export")) {
  const [file] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), trigger.click()]);
  return { name: file.suggestedFilename(), bytes: readFileSync((await file.path())!) };
}
async function decode(page: Page, bytes: Buffer, type: string) {
  return page.evaluate(async ({ base64, type }) => {
    const blob = new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!; ctx.drawImage(bitmap, 0, 0);
    const sample = (x: number) => [...ctx.getImageData(x, Math.min(10, bitmap.height - 1), 1, 1).data];
    const result = { width: bitmap.width, height: bitmap.height, left: sample(Math.min(10, bitmap.width - 1)), right: sample(Math.floor(bitmap.width * .75)) };
    bitmap.close(); canvas.width = 0; canvas.height = 0; return result;
  }, { base64: bytes.toString("base64"), type });
}

test("PNG retains exact pixels, compares native detail, and repeat checks/downloads reuse output", async ({ page }, testInfo) => {
  const original = await open(page);
  await page.getByRole("group", { name: "Comparison zoom" }).getByRole("button", { name: "100%", exact: true }).click();
  await expect(page.getByTestId("encode-original-image")).toHaveJSProperty("naturalWidth", 800);
  await page.getByRole("region", { name: "Original comparison view" }).evaluate((element) => { element.scrollLeft = 90; });
  await check(page);
  const first = await counters(page);
  const zoom = page.getByRole("group", { name: "Comparison zoom" });
  await zoom.getByRole("button", { name: "100%", exact: true }).click();
  await expect(page.getByTestId("encode-original-image")).toHaveJSProperty("naturalWidth", 800);
  await expect(page.getByTestId("encode-original-image")).toHaveCSS("width", "800px");
  await expect(page.getByTestId("encode-result-image")).toHaveJSProperty("naturalWidth", 800);
  await expect.poll(() => page.getByRole("region", { name: "Result comparison view" }).evaluate((element) => Math.round(element.scrollLeft))).toBe(90);
  await page.getByRole("region", { name: "Original comparison view" }).evaluate((element) => { element.scrollLeft = 100; });
  await expect.poll(() => page.getByRole("region", { name: "Result comparison view" }).evaluate((element) => Math.round(element.scrollLeft))).toBe(100);
  await zoom.getByRole("button", { name: "200%", exact: true }).click();
  await expect(page.getByTestId("encode-result-image")).toHaveCSS("width", "1600px");
  await zoom.getByRole("button", { name: "100%", exact: true }).click();
  const originalView = page.getByRole("region", { name: "Original comparison view" });
  await originalView.focus();
  await originalView.press("0");
  await expect(zoom.getByRole("button", { name: "Fit", exact: true })).toHaveAttribute("aria-pressed", "true");
  await originalView.press("1");
  await expect(page.getByTestId("encode-original-image")).toHaveCSS("width", "800px");
  await originalView.evaluate((element) => { element.scrollLeft = 120; });
  await expect.poll(() => page.getByRole("region", { name: "Result comparison view" }).evaluate((element) => Math.round(element.scrollLeft))).toBe(120);
  await page.screenshot({ path: testInfo.outputPath("desktop-compressor.png"), fullPage: false });
  await check(page);
  const output = await download(page);
  expect(output.name).toBe("compressed-fixture.png");
  expect(PNG.sync.read(output.bytes).data).toEqual(PNG.sync.read(original.buffer).data);
  expect(output.bytes.length).toBe(Number(await page.getByTestId("encode-comparison").getAttribute("data-output")));
  await download(page);
  expect(await counters(page)).toEqual(first);
  await expect(page.getByTestId("file-item")).toHaveCount(2);
});

for (const [type, label] of [["image/jpeg", "JPEG"], ["image/webp", "WebP"]]) {
  test(`${label} compression keeps dimensions and the actual downloaded MIME`, async ({ page }) => {
    await open(page, type, 400, 300, label === "WebP" ? "alpha" : "detail");
    await expect(format(page, label)).toHaveAttribute("aria-checked", "true");
    await check(page); const output = await download(page);
    if (label === "JPEG") expect([...output.bytes.subarray(0, 3)]).toEqual([255, 216, 255]);
    else { expect(output.bytes.subarray(0, 4).toString()).toBe("RIFF"); expect(output.bytes.subarray(8, 12).toString()).toBe("WEBP"); }
    const pixels = await decode(page, output.bytes, type);
    expect([pixels.width, pixels.height]).toEqual([400, 300]);
    if (label === "WebP") expect(pixels.left[3]).toBe(0);
    expect(output.bytes.length).toBe(Number(await page.getByTestId("encode-comparison").getAttribute("data-output")));
  });
}

test("target success/failure is measured and resizing happens only after explicit consent", async ({ page }) => {
  const posted: string[] = [];
  page.on("request", (request) => { if (!["GET", "HEAD"].includes(request.method()) && request.postDataBuffer()?.length) posted.push(request.url()); });
  await open(page, "image/png", 600, 400, "noise");
  await format(page, "WebP").click();
  await page.getByRole("radio", { name: "500 KB", exact: true }).click();
  await check(page);
  await expect(page.getByTestId("encode-target-result")).toHaveAttribute("data-target-met", "true");
  await page.getByRole("textbox", { name: "Custom target in KB" }).fill("1");
  await page.getByRole("textbox", { name: "Custom target in KB" }).press("Enter");
  await check(page);
  await expect(page.getByTestId("encode-target-result")).toHaveAttribute("data-target-met", "false");
  await expect(page.getByRole("checkbox", { name: "Resize image" })).not.toBeChecked();
  await expect(page.getByTestId("encode-result-meta")).toContainText("600 × 400");
  const resize = page.getByTestId("compressor-resize-suggestion");
  const match = (await resize.innerText()).match(/(\d+) × (\d+)/)!;
  await resize.click();
  await expect(page.getByTestId("encode-result-meta")).toContainText(`${match[1]} × ${match[2]}`);
  await expect(page.getByText("Settings changed since this result.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Resize image" })).toBeChecked();
  const output = await download(page); const pixels = await decode(page, output.bytes, "image/webp");
  expect([pixels.width, pixels.height]).toEqual([Number(match[1]), Number(match[2])]);
  expect(await page.getByTestId("encode-target-result").getAttribute("data-target-met")).toBe(String(output.bytes.length <= 1024));
  await expect(page.getByTestId("encode-original-meta")).toContainText("600 × 400");
  expect(posted).toEqual([]);
});

test("explicit PNG resizing retains alpha and JPEG uses the selected background", async ({ page }) => {
  await open(page, "image/png", 200, 120, "alpha");
  await page.getByRole("checkbox", { name: "Resize image" }).check();
  await page.getByRole("textbox", { name: "Resize percentage" }).fill("50");
  await page.getByRole("textbox", { name: "Resize percentage" }).press("Enter");
  await check(page); const png = await download(page);
  const transparent = await decode(page, png.bytes, "image/png");
  expect([transparent.width, transparent.height, transparent.left[3]]).toEqual([100, 60, 0]);
  await format(page, "JPEG").click();
  await page.getByLabel("Custom background colour").fill("#3366cc");
  await check(page); const jpg = await download(page);
  const flattened = await decode(page, jpg.bytes, "image/jpeg");
  expect([flattened.width, flattened.height, flattened.left[3]]).toEqual([100, 60, 255]);
  expect(flattened.left.slice(0, 3).every((channel, i) => Math.abs(channel - [51, 102, 204][i]) <= 10)).toBe(true);
  await page.getByRole("button", { name: "Reset settings" }).click();
  await expect(page.getByRole("checkbox", { name: "Resize image" })).not.toBeChecked();
  await expect(format(page, "PNG")).toHaveAttribute("aria-checked", "true");
  await check(page);
  await expect(page.getByTestId("encode-result-meta")).toContainText("200 × 120");
});

test("measured format choices reuse candidates and never change format automatically", async ({ page }) => {
  await open(page); await check(page);
  await page.getByTestId("compare-formats").click();
  await expect(page.getByTestId("format-comparison")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("format-comparison-summary")).toContainText("smallest measured file");
  await expect(format(page, "PNG")).toHaveAttribute("aria-checked", "true");
  const measured = await counters(page);
  if (measured.requests.length) expect(measured.requests.find((request) => request.op === "image.compareFormats")?.existing).toBe(1);
  else expect(measured.domEncodes).toBe(3);
  await page.getByRole("button", { name: "Use measured WebP" }).click();
  await expect(format(page, "WebP")).toHaveAttribute("aria-checked", "true");
  await download(page);
  expect(await counters(page)).toEqual(measured);
});

test("cancelled and superseded work cannot replace the latest settings or create downloads", async ({ page }) => {
  await open(page, "image/jpeg");
  await page.evaluate(() => { (window as unknown as TestWindow).compressorTest.hold = true; });
  await page.getByTestId("encode-check").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).compressorTest.held)).toBe(true);
  await page.getByRole("button", { name: "Cancel compression" }).click();
  await expect(page.getByTestId("encode-comparison")).toHaveCount(0);
  await page.getByRole("slider", { name: "JPEG quality", exact: true }).fill("55");
  await page.getByRole("slider", { name: "JPEG quality", exact: true }).fill("60");
  await page.getByTestId("encode-check").click();
  await page.evaluate(() => (window as unknown as TestWindow).compressorTest.release!());
  await expect(page.getByTestId("encode-result-meta")).toContainText("at 60% quality", { timeout: 120_000 });
  await expect(page.getByTestId("file-item")).toHaveCount(1);
  const output = await download(page);
  expect(output.bytes.length).toBe(Number(await page.getByTestId("encode-comparison").getAttribute("data-output")));
});

test("mobile zoom, resize controls and downloaded dimensions stay usable", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.getByTestId("mobile-inspector-trigger").click();
  const sheet = page.getByRole("dialog", { name: "Compress settings" });
  await sheet.getByRole("radio", { name: "WebP", exact: true }).click();
  await sheet.getByRole("checkbox", { name: "Resize image" }).check();
  await sheet.getByRole("textbox", { name: "Resize percentage" }).fill("50");
  await sheet.getByRole("textbox", { name: "Resize percentage" }).press("Enter");
  await sheet.getByTestId("encode-check").click();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("encode-result-meta")).toContainText("400 × 300", { timeout: 120_000 });
  const actual = page.getByRole("group", { name: "Comparison zoom" }).getByRole("button", { name: "100%", exact: true });
  expect((await actual.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await actual.click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("mobile-compressor.png"), fullPage: false });
  const output = await download(page, page.getByRole("button", { name: "Export", exact: true }));
  const pixels = await decode(page, output.bytes, "image/webp");
  expect([pixels.width, pixels.height]).toEqual([400, 300]);
});

test("large WebP dimensions are blocked and recover only after explicit downscaling", async ({ page }) => {
  await open(page, "image/png", 100, 17000);
  await format(page, "WebP").click();
  await expect(page.getByTestId("encode-issue")).toContainText("16,383");
  await expect(page.getByTestId("encode-check")).toBeDisabled();
  await page.getByRole("checkbox", { name: "Resize image" }).check();
  await page.getByRole("textbox", { name: "Resize percentage" }).fill("50");
  await page.getByRole("textbox", { name: "Resize percentage" }).press("Enter");
  await expect(page.getByTestId("encode-issue")).toHaveCount(0);
  await check(page); const output = await download(page);
  const pixels = await decode(page, output.bytes, "image/webp");
  expect([pixels.width, pixels.height]).toEqual([50, 8500]);
});

test("large native previews are bounded instead of claiming proxy pixels are full resolution", async ({ page }) => {
  await open(page, "image/png", 4000, 2400);
  await expect(page.getByText(/Reduced previews: full-resolution comparison/)).toBeVisible();
  await expect(page.getByRole("group", { name: "Comparison zoom" }).getByRole("button", { name: "100%", exact: true })).toBeDisabled();
});
