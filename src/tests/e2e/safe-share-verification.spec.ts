import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { inspectBytes } from "@/core/metadata/engine-core";
import { FIXTURE_DIR } from "../helpers/stitch-fixtures";

type VerificationTestWindow = Window & {
  redactionTest: { failFormat: boolean; holdOcr: boolean; ocrPending: boolean; failOcr?: () => void };
};

test.use({ viewport: { width: 1440, height: 960 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("shotexa.analytics-consent.v1", "rejected");
    localStorage.setItem("shotexa.vercel-analytics-opt-out.v1", "true");
    const gate: VerificationTestWindow["redactionTest"] = { failFormat: false, holdOcr: false, ocrPending: false };
    (window as unknown as VerificationTestWindow).redactionTest = gate;
    // Exercise the DOM-canvas fallback as well as the OffscreenCanvas worker path.
    const nativeToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      nativeToBlob.call(this, callback, gate.failFormat ? "image/jpeg" : type, quality);
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", (event: MessageEvent) => {
          const message = event.data;
          if (gate.failFormat && message.type === "SUCCESS" && message.jobId?.startsWith("redaction.export:")) {
            message.output.verification.formatMatch = false;
          }
        });
      }
      postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
        const packet = message as { action?: string; workerId?: string; jobId?: string };
        if (gate.holdOcr && packet.action === "recognize") {
          gate.ocrPending = true;
          gate.failOcr = () => {
            gate.holdOcr = false;
            this.dispatchEvent(new MessageEvent("message", { data: {
              workerId: packet.workerId, jobId: packet.jobId, action: "recognize", status: "reject", data: "Synthetic optional OCR failure",
            } }));
          };
          return;
        }
        super.postMessage(message, transfer as Transferable[]);
      }
    };
  });
});

async function openManual(page: Page) {
  await page.goto("/redact-screenshot");
  await page.getByTestId("file-input").setInputFiles(join(FIXTURE_DIR, "chat-light/a.png"));
  const stage = page.getByLabel(/Screenshot redaction canvas/);
  await expect(stage).toBeVisible({ timeout: 30_000 });
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId("redaction-region")).toHaveCount(1);
}

async function openScanned(page: Page, testInfo: TestInfo, twoEmails = false) {
  const maker = await page.context().newPage();
  await maker.setViewportSize({ width: 1200, height: 500 });
  await maker.setContent('<style>body{margin:0;padding:60px;background:white;color:#111;font:42px/2 Arial,sans-serif}</style><div>Email: alex@example.com</div>' + (twoEmails ? '<div>Email: second@example.com</div>' : ""));
  const file = testInfo.outputPath("review-input.png");
  await maker.screenshot({ path: file, scale: "css" });
  await maker.close();
  await page.goto("/redact-screenshot");
  await page.getByTestId("file-input").setInputFiles(file);
  await expect(page.getByTestId("redaction-editor")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Scan screenshot" }).click();
  await expect(page.getByTestId("privacy-review").getByText(/possible sensitive item/)).toBeVisible({ timeout: 180_000 });
  await page.getByRole("button", { name: /Redact Selected/ }).click();
  await expect(page.getByTestId("redaction-region")).toHaveCount(twoEmails ? 2 : 1);
}

test("a failed format verification never shows a successful output or publishes a copy", async ({ page }) => {
  await openManual(page);
  await page.evaluate(() => { (window as unknown as VerificationTestWindow).redactionTest.failFormat = true; });
  await page.getByTestId("export").click();
  await expect(page.getByRole("alert").filter({ hasText: "Safe Share could not export" })).toBeVisible();
  await expect(page.getByTestId("safe-share-result")).toHaveCount(0);
  await expect(page.getByText("Output verified", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("file-item")).toHaveCount(1);
});

test("optional OCR completes and its failure warning is shown before manual review can publish", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await openScanned(page, testInfo);
  await page.evaluate(() => { (window as unknown as VerificationTestWindow).redactionTest.holdOcr = true; });
  await page.getByTestId("export").click();
  const review = page.getByRole("checkbox", { name: /I inspected the final image/ });
  await expect.poll(() => page.evaluate(() => (window as unknown as VerificationTestWindow).redactionTest.ocrPending), { timeout: 180_000 }).toBe(true);
  await expect(page.getByTestId("safe-share-text-check")).toContainText("Checking");
  await expect(review).toBeDisabled();
  await expect(review).not.toBeChecked();
  await expect(page.getByTestId("export")).toBeDisabled();
  await expect(page.getByTestId("file-item")).toHaveCount(1);
  await page.evaluate(() => (window as unknown as VerificationTestWindow).redactionTest.failOcr!());
  await expect(page.getByRole("alert").filter({ hasText: "optional text check could not run" })).toBeVisible();
  await expect(review).toBeEnabled();
  await expect(review).not.toBeChecked();
  await expect(page.getByTestId("file-item")).toHaveCount(1);
  await expect(page.getByTestId("export")).toBeDisabled();
  await review.check();
  await expect(page.getByTestId("file-item")).toHaveCount(2);
  await expect(page.getByTestId("export")).toBeEnabled();
});

test("residual sensitive text is warned about before the copy is marked reviewed", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await openScanned(page, testInfo, true);
  await page.getByRole("button", { name: /Delete blackout redaction/ }).first().click();
  await page.getByTestId("export").click();
  const review = page.getByRole("checkbox", { name: /I inspected the final image/ });
  await expect(page.getByRole("alert").filter({ hasText: "Sensitive text may still be visible" })).toBeVisible({ timeout: 180_000 });
  await expect(review).toBeEnabled();
  await expect(review).not.toBeChecked();
  await expect(page.getByTestId("file-item")).toHaveCount(1);
  await expect(page.getByTestId("export")).toBeDisabled();
});

test("a successful local text check still requires manual review before download", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const posted: string[] = [];
  page.on("request", (request) => { if (!["GET", "HEAD"].includes(request.method()) && request.postDataBuffer()?.length) posted.push(request.url()); });
  await openScanned(page, testInfo);
  await page.getByTestId("export").click();
  await expect(page.getByTestId("safe-share-text-check")).toContainText("found no matching sensitive text", { timeout: 180_000 });
  const review = page.getByRole("checkbox", { name: /I inspected the final image/ });
  await expect(review).not.toBeChecked();
  await expect(page.getByTestId("file-item")).toHaveCount(1);
  await expect(page.getByTestId("export")).toBeDisabled();
  await review.check();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export").click()]);
  const bytes = readFileSync((await download.path())!);
  const output = PNG.sync.read(bytes);
  expect([output.width, output.height]).toEqual([1200, 500]);
  expect(inspectBytes(new Uint8Array(bytes)).hasPrivacyMetadata).toBe(false);
  expect(posted).toEqual([]);
});
