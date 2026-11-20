import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { inspectBytes, verifyBytes } from "@/core/metadata/engine-core";

test("Privacy Clean verifies and downloads only the selected result", async ({ page }) => {
  const original = readFileSync(join(process.cwd(), "src/tests/fixtures/metadata/png/text.png"));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/remove-image-metadata");
  await page.getByTestId("file-input").setInputFiles([
    { name: "first.png", mimeType: "image/png", buffer: original },
    { name: "second.png", mimeType: "image/png", buffer: original },
  ]);
  await page.getByRole("button", { name: /1\. first\.png,/ }).click();
  const action = page.getByTestId("export");
  await expect(action).toContainText("Privacy Clean");
  const [download] = await Promise.all([page.waitForEvent("download"), action.click()]);
  expect(download.suggestedFilename()).toBe("privacy-clean-first.png");
  const output = readFileSync((await download.path())!);
  expect(inspectBytes(output)).toMatchObject({ format: "png", hasPrivacyMetadata: false });
  expect(verifyBytes(output, { original })).toMatchObject({ passed: true, payloadIdentical: true });
  expect(PNG.sync.read(output).data).toEqual(PNG.sync.read(original).data);
  await expect(page.getByTestId("metadata-result")).toBeVisible();
  await page.getByRole("button", { name: /2\. second\.png,/ }).click();
  await expect(action).toContainText("Privacy Clean");
  await expect(page.getByTestId("metadata-result")).toHaveCount(0);
});

test("a slow SVG read cannot replace a newer selection or its exported pixels", async ({ page }) => {
  await page.addInitScript(() => {
    const read = File.prototype.text;
    File.prototype.text = function () {
      if (this.name !== "slow.svg") return read.call(this);
      return new Promise<string>((resolve) => {
        document.addEventListener("finish-slow-svg", () => {
          void read.call(this).then((value) => {
            resolve(value);
            requestAnimationFrame(() => requestAnimationFrame(() => {
              document.documentElement.dataset.slowSvgReleased = "true";
            }));
          });
        }, { once: true });
        document.documentElement.dataset.slowSvgPending = "true";
      });
    };
  });
  await page.goto("/svg-to-png");
  const input = page.getByLabel("SVG file");
  const svg = (width: number, fill: string) =>
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20"><rect width="10" height="20" fill="${fill}"/></svg>`);
  await input.setInputFiles({ name: "slow.svg", mimeType: "image/svg+xml", buffer: svg(60, "#ff0000") });
  await expect(page.locator("html")).toHaveAttribute("data-slow-svg-pending", "true");
  await input.setInputFiles({ name: "latest.svg", mimeType: "image/svg+xml", buffer: svg(40, "#00ff00") });
  await expect(page.getByLabel("Width")).toHaveValue("40");
  await page.evaluate(() => document.dispatchEvent(new Event("finish-slow-svg")));
  await expect(page.locator("html")).toHaveAttribute("data-slow-svg-released", "true");
  await page.getByRole("button", { name: "Convert", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download", exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("latest.png");
  const output = PNG.sync.read(readFileSync((await download.path())!));
  expect([output.width, output.height]).toEqual([40, 20]);
  expect([...output.data.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
  expect(output.data[(5 * output.width + 20) * 4 + 3]).toBe(0);
});
