import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { unzipSync } from "fflate";

function image(name: string, width = 80, height = 60, noise = false) {
  const png = new PNG({ width, height }); let seed = 123;
  for (let i = 0; i < png.data.length; i += 4) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; png.data.set(noise ? [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255, 255] : [12, 65, 190, 255], i); }
  return { name, mimeType: "image/png", buffer: PNG.sync.write(png) };
}
async function open(page: Page, files = [image("one.png"), image("two.png"), image("three.png")]) {
  await page.goto("/batch-screenshots");
  await page.getByTestId("file-input").setInputFiles(files);
  await expect(page.getByTestId("batch-file-list")).toBeVisible();
}
async function process(page: Page, count = 3) {
  await page.getByTestId("export").click();
  await expect(page.getByTestId("batch-results")).toContainText(`${count} files ready`, { timeout: 60_000 });
}
const zipButton = (page: Page) => page.getByTestId("batch-results").getByRole("button", { name: "Download ZIP", exact: true });
async function zip(page: Page) {
  const [download] = await Promise.all([page.waitForEvent("download"), zipButton(page).click()]);
  return unzipSync(readFileSync((await download.path())!));
}
test.describe.configure({ timeout: 180_000 });

test("configured limits, stable source order and individual file correctness", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("batch-limits")).toContainText("50 input files");
  await expect(page.getByTestId("batch-limits")).toContainText("512"); await expect(page.getByTestId("batch-limits")).toContainText("96");
  await page.getByRole("checkbox", { name: "Include one.png", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Include one.png", exact: true }).check();
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await page.getByRole("checkbox", { name: "Include one.png", exact: true }).check();
  await page.getByRole("checkbox", { name: "Include three.png", exact: true }).click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("batch-file-list").getByRole("checkbox", { checked: true })).toHaveCount(3);
  await process(page);
  const entries = await zip(page); expect(Object.keys(entries)).toEqual(["compressed-one.png", "compressed-two.png", "compressed-three.png"]);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("batch-result-list").getByRole("button", { name: "Download", exact: true }).first().click()]);
  expect(download.suggestedFilename()).toBe("compressed-one.png"); expect(readFileSync((await download.path())!)).toEqual(Buffer.from(entries["compressed-one.png"]));
});

test("a refused ZIP keeps individual downloads usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Fault injection exercises the real limit UI/ZIP path without allocating >96 MiB on CI.
  // Unit tests separately enforce the actual configured 96 MiB boundary including headers.
  let replaced = 0;
  await page.route("**/_next/static/chunks/*.js", async (route) => {
    const response = await route.fetch(); const body = await response.text();
    const patched = body.replace(/("[^"\n]+",0,50,"[^"\n]+",0,(?:0x20000000|536870912),"[^"\n]+",0,)(?:0x6000000|100663296)/g, (_match, prefix: string) => `${prefix}4096`);
    if (patched !== body) { replaced++; await route.fulfill({ response, body: patched }); }
    else await route.fulfill({ response });
  });
  const inputs = [image("one.png", 100, 100, true), image("two.png", 100, 100, true)]; await open(page, inputs);
  expect(replaced).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Batch settings", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Batch settings", exact: true });
  await sheet.getByRole("radiogroup", { name: "Batch operation" }).getByRole("radio", { name: "Privacy Clean", exact: true }).click(); await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByTestId("batch-results")).toContainText("2 files ready");
  await expect(page.getByTestId("batch-zip-state")).toContainText("Too large for one ZIP"); await expect(zipButton(page)).toBeDisabled();
  const target = page.getByTestId("batch-result-list").getByRole("button", { name: "Download", exact: true }).first();
  expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const [download] = await Promise.all([page.waitForEvent("download"), target.click()]); expect(readFileSync((await download.path())!)).toEqual(inputs[0].buffer);
});

async function holdFirstEncoding(page: Page) {
  await page.addInitScript(() => {
    let held = false;
    const state = window as unknown as { releaseEncoding?: () => void };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      const send = () => Reflect.apply(post, this, options === undefined ? [message] : [message, options]);
      const data = message as { type?: string; op?: string };
      if (!held && data?.type === "RUN" && data.op === "image.encode") { held = true; state.releaseEncoding = send; return; }
      send();
    };
    const encode = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      if (!held) { held = true; state.releaseEncoding = () => encode.call(this, callback, type, quality); return; }
      return encode.call(this, callback, type, quality);
    };
  });
}
test("cancel before any output exposes resume, preserves filenames and leaves no half-result", async ({ page }) => {
  await holdFirstEncoding(page); await open(page); await page.getByTestId("export").click();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseEncoding?: unknown }).releaseEncoding)).toBe("function");
  await page.getByRole("button", { name: "Cancel", exact: true }).click(); await page.evaluate(() => (window as unknown as { releaseEncoding(): void }).releaseEncoding());
  await expect(page.getByTestId("batch-results")).toContainText("0 completed · 0 failed · 3 unprocessed");
  await expect(page.getByTestId("batch-result-list").getByRole("button", { name: "Download", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Resume unprocessed", exact: true }).click(); await expect(page.getByTestId("batch-results")).toContainText("3 files ready");
  expect(Object.keys(await zip(page))).toEqual(["compressed-one.png", "compressed-two.png", "compressed-three.png"]);
});

test("ZIP creation failure retains outputs and permits a successful retry", async ({ page }) => {
  await page.addInitScript(() => {
    const stream = Blob.prototype.stream;
    Blob.prototype.stream = function () {
      const state = window as unknown as { failZip?: boolean };
      if (state.failZip && this.type === "image/png") { state.failZip = false; throw new Error("Controlled archive failure"); }
      return stream.call(this);
    };
  });
  await open(page); await process(page); await page.evaluate(() => { (window as unknown as { failZip: boolean }).failZip = true; });
  await zipButton(page).click(); await expect(page.getByTestId("batch-zip-state")).toContainText("could not be created");
  await expect(page.getByTestId("batch-result-list").getByRole("button", { name: "Download", exact: true })).toHaveCount(3);
  expect(Object.keys(await zip(page))).toHaveLength(3);
});

test("ZIP cancellation keeps outputs, releases native readers and permits retry", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Blob.prototype.stream;
    const state = window as unknown as { slowZip?: boolean; cancelledReaders?: number };
    state.cancelledReaders = 0;
    Blob.prototype.stream = function () {
      const input = original.call(this);
      if (!state.slowZip || this.type !== "image/png") return input;
      const reader = input.getReader(); let stopped = false;
      return new ReadableStream({ async pull(controller) { await new Promise((resolve) => setTimeout(resolve, 400)); if (stopped) return; const next = await reader.read(); if (stopped) return; if (next.done) controller.close(); else controller.enqueue(next.value); }, async cancel() { stopped = true; state.cancelledReaders!++; await reader.cancel(); reader.releaseLock(); } });
    };
  });
  await open(page); await process(page); await page.evaluate(() => { (window as unknown as { slowZip: boolean }).slowZip = true; });
  await zipButton(page).click(); await page.getByRole("button", { name: "Cancel ZIP", exact: true }).click();
  await expect(page.getByTestId("batch-zip-state")).toContainText("ZIP creation stopped");
  await expect.poll(() => page.evaluate(() => (window as unknown as { cancelledReaders: number }).cancelledReaders)).toBeGreaterThan(0);
  await page.evaluate(() => { (window as unknown as { slowZip: boolean }).slowZip = false; });
  expect(Object.keys(await zip(page))).toHaveLength(3);
});
