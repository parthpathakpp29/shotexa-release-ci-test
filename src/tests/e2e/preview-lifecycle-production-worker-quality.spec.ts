import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { isPreviewConsoleError } from "../helpers/preview-errors";

type Record = { worker: Worker; terminated: number; errorHandlers: ((event: Event) => void)[]; release?: () => void };
type Probe = { workers: Record[] };

async function holdPreview(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (isPreviewConsoleError(message.type(), message.text())) errors.push(message.text()); });
  await page.addInitScript(() => {
    const probe: Probe = { workers: [] };
    (window as unknown as { workerRace: Probe }).workerRace = probe;
    const Native = Worker;
    window.Worker = new Proxy(Native, { construct(target, args) {
      const worker = Reflect.construct(target, args) as Worker;
      const item: Record = { worker, terminated: 0, errorHandlers: [] };
      const listen = worker.addEventListener;
      worker.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
        if (type === "error" && listener) item.errorHandlers.push((event) => {
          if (typeof listener === "function") listener.call(worker, event); else listener.handleEvent(event);
        });
        return Reflect.apply(listen, worker, [type, listener, options]);
      }) as Worker["addEventListener"];
      probe.workers.push(item); return worker;
    } });
    const nativePost = Native.prototype.postMessage, nativeStop = Native.prototype.terminate;
    Native.prototype.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      const args = options === undefined ? [message] : [message, options];
      const item = probe.workers.find((entry) => entry.worker === this);
      const request = message as { type?: string; op?: string };
      if (item && !item.release && request.type === "RUN" && request.op === "image.preview") {
        item.release = () => Reflect.apply(nativePost, this, args); return;
      }
      return Reflect.apply(nativePost, this, args);
    };
    Native.prototype.terminate = function () {
      const item = probe.workers.find((entry) => entry.worker === this); if (item) item.terminated++;
      return Reflect.apply(nativeStop, this, []);
    };
  });
  const png = new PNG({ width: 80, height: 60 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([35, 90, 160, 255], i);
  await page.goto("/compress-screenshot");
  await page.getByTestId("file-input").setInputFiles({ name: "worker-race.png", mimeType: "image/png", buffer: PNG.sync.write(png) });
  await page.waitForFunction(() => (window as unknown as { workerRace: Probe }).workerRace.workers[0]?.release);
  return errors;
}

async function finishAndVerify(page: Page, errors: string[]) {
  expect(await page.evaluate(() => (window as unknown as { workerRace: Probe }).workerRace.workers[1].terminated)).toBe(0);
  await page.evaluate(() => (window as unknown as { workerRace: Probe }).workerRace.workers[1].release!());
  await expect.poll(() => page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('section[aria-label="Screenshots"] canvas');
    return canvas?.width ? canvas.getContext("2d")?.getImageData(0, 0, 1, 1).data[3] : 0;
  })).toBe(255);
  await expect(page.getByRole("button", { name: "Retry previews", exact: true })).toHaveCount(0);
  await page.getByTestId("encode-check").click();
  await expect(page.getByTestId("encode-result-image")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export").click()]);
  const output = PNG.sync.read(readFileSync((await download.path())!));
  expect([output.width, output.height]).toEqual([80, 60]); expect([...output.data.subarray(0, 4)]).toEqual([35, 90, 160, 255]);
  expect(errors).toEqual([]);
}

test("a retired worker's late error cannot break retry or its downloaded output", async ({ page }) => {
  const errors = await holdPreview(page);
  expect(await page.evaluate(() => {
    const first = (window as unknown as { workerRace: Probe }).workerRace.workers[0];
    return first.worker.dispatchEvent(new ErrorEvent("error", { cancelable: true, message: "controlled startup failure" }));
  })).toBe(false);
  await page.getByRole("button", { name: "Retry previews", exact: true }).click();
  await page.waitForFunction(() => (window as unknown as { workerRace: Probe }).workerRace.workers[1]?.release);
  // Replay an already-queued callback: WebKit removes native listeners on terminate().
  expect(await page.evaluate(() => {
    const event = new ErrorEvent("error", { cancelable: true, message: "late retired-worker failure" });
    const first = (window as unknown as { workerRace: Probe }).workerRace.workers[0];
    if (!first.errorHandlers.length) throw new Error("No original worker error handler captured");
    first.errorHandlers.forEach((handler) => handler(event)); return event.defaultPrevented;
  })).toBe(true);
  await finishAndVerify(page, errors);
});

test("pending worker work stops on unload and a persisted-page restore can process again", async ({ page }) => {
  const errors = await holdPreview(page);
  await page.evaluate(() => window.dispatchEvent(new Event("beforeunload")));
  expect(await page.evaluate(() => (window as unknown as { workerRace: Probe }).workerRace.workers[0].terminated)).toBe(1);
  await expect(page.getByTestId("file-loading-feedback")).toContainText("Preview loading stopped");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await page.waitForFunction(() => (window as unknown as { workerRace: Probe }).workerRace.workers[1]?.release);
  await finishAndVerify(page, errors);
});
