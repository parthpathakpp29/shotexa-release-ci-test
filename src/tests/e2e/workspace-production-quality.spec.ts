import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

function image(name = "workspace.png") {
  const png = new PNG({ width: 160, height: 120 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([40, 120, 200, i % 32 ? 255 : 0], i);
  return { name, mimeType: "image/png", buffer: PNG.sync.write(png) };
}
async function upload(page: Page, route = "/compress-screenshot", files = [image()]) {
  await page.goto(route);
  await page.getByTestId("file-input").setInputFiles(files);
  await expect(page.getByTestId("workspace-drop-zone")).toBeVisible();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
test.use({ viewport: { width: 1440, height: 960 } });

for (const viewport of [{ width: 320, height: 700 }, { width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1440, height: 960 }]) {
  test(`${viewport.width}px keeps one visible inspector and downloads exact PNG pixels`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const input = image();
    await upload(page, "/compress-screenshot", [input]);
    if (viewport.width < 768) {
      await expect(page.getByTestId("encode-inspector")).toHaveCount(0);
      await expect(page.getByTestId("file-list")).toHaveCount(0);
      await page.getByTestId("mobile-inspector-trigger").click();
    }
    await expect(page.getByTestId("encode-inspector")).toHaveCount(1);
    await expect(page.getByTestId("encode-inspector")).toBeVisible();
    await noOverflow(page);
    if (viewport.width < 768) {
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("mobile-inspector-trigger")).toBeFocused();
    }
    const control = viewport.width < 768 ? page.getByRole("button", { name: "Export", exact: true }) : page.getByTestId("export");
    await expect(control).toBeEnabled();
    const [download] = await Promise.all([page.waitForEvent("download"), control.click()]);
    expect(download.suggestedFilename()).toMatch(/\.png$/);
    const result = PNG.sync.read(readFileSync((await download.path())!));
    const source = PNG.sync.read(input.buffer);
    expect([result.width, result.height]).toEqual([160, 120]);
    // Invisible RGB is unspecified by canvas; every visible channel and alpha must survive.
    let changed = 0;
    for (let i = 0; i < source.data.length; i += 4) {
      if (result.data[i + 3] !== source.data[i + 3]) changed++;
      if (source.data[i + 3] && !result.data.subarray(i, i + 3).equals(source.data.subarray(i, i + 3))) changed++;
    }
    expect(changed).toBe(0);
  });
}

test("tool menu supports arrows, Home/End, typeahead, Tab, Escape and keyboard navigation", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await upload(page);
  const trigger = page.getByRole("button", { name: "Compress", exact: true });
  await trigger.focus();
  await trigger.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "Switch tool" });
  const items = menu.getByRole("menuitem");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown"); await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("End"); await expect(items.last()).toBeFocused();
  await page.keyboard.press("ArrowDown"); await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowUp"); await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home"); await expect(items.first()).toBeFocused();
  await page.keyboard.press("c");
  expect(await menu.evaluate(el => document.activeElement?.textContent?.trim().toLowerCase().startsWith("c") && el.contains(document.activeElement))).toBe(true);
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect((await items.first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await noOverflow(page);
  await page.keyboard.press("Escape"); await expect(menu).toHaveCount(0); await expect(trigger).toBeFocused();
  await trigger.click(); await expect(menu).toBeVisible();
  await trigger.click(); await expect(menu).toHaveCount(0); await expect(trigger).toBeFocused();
  await trigger.press("ArrowUp"); await expect(items.last()).toBeFocused();
  await page.keyboard.press("Shift+Tab"); await expect(menu).toHaveCount(0); await expect(trigger).toBeFocused();
  await trigger.press("Enter"); await page.keyboard.press("Tab"); await expect(menu).toHaveCount(0);
  expect(await trigger.evaluate(el => el.contains(document.activeElement))).toBe(false);
  await trigger.focus(); await trigger.press("Enter");
  const convert = items.filter({ hasText: /^Convert$/ });
  await convert.focus(); await convert.press("Enter");
  await expect(page).toHaveURL(/\/convert-screenshot$/);
  await expect(page.getByRole("button", { name: "Files (1)", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Convert", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Files (1)", exact: true }).click();
  await expect(page.getByTestId("file-item")).toHaveCount(1);
  await expect(page.getByTestId("file-item")).toContainText("workspace.png");
});

test("radio arrows move focus and selection together; mobile sliders have 44px targets", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await upload(page); await page.getByTestId("mobile-inspector-trigger").click();
  const dialog = page.getByRole("dialog");
  const radios = dialog.getByRole("radiogroup", { name: "Output format" }).getByRole("radio");
  await radios.first().focus();
  for (const [key, index] of [["ArrowRight", 1], ["ArrowRight", 2], ["ArrowRight", 0], ["ArrowUp", 2], ["Home", 0], ["End", 2]] as const) {
    await page.keyboard.press(key);
    await expect(radios.nth(index)).toBeFocused(); await expect(radios.nth(index)).toBeChecked();
  }
  const slider = dialog.getByRole("slider", { name: "WebP quality", exact: true });
  expect((await slider.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await slider.focus(); const before = Number(await slider.inputValue());
  await slider.press("ArrowLeft"); await expect(slider).toHaveValue(String(before - 1));
  await page.keyboard.press("Escape"); await page.getByTestId("mobile-inspector-trigger").click();
  await expect(dialog.getByRole("radio", { name: "WebP", exact: true })).toBeChecked();
});

test("settings trap focus, restore their opener and close at the tablet breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await upload(page);
  const trigger = page.getByTestId("mobile-inspector-trigger");
  await trigger.focus(); await trigger.press("Enter");
  const dialog = page.getByRole("dialog"), close = dialog.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeFocused();
  await close.press("Shift+Tab"); await expect(dialog.getByTestId("mobile-sheet-export")).toBeFocused();
  await page.keyboard.press("Tab"); await expect(close).toBeFocused();
  await close.press("Escape"); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await trigger.click(); await close.click(); await expect(trigger).toBeFocused();
  await trigger.click(); await page.setViewportSize({ width: 820, height: 1180 });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("main", { name: "Compress workspace" })).toBeFocused();
  await expect(page.getByTestId("encode-inspector")).toHaveCount(1);
  await expect(page.getByTestId("encode-inspector")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toHaveCount(0); await expect(page.getByTestId("encode-inspector")).toHaveCount(0);
  await trigger.click(); await expect(page.getByTestId("encode-inspector")).toHaveCount(1);
});

test("mobile files preserve order, offer keyboard upload and return focus after selection", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/compress-screenshot");
  const choose = page.getByRole("button", { name: /^Choose screenshots/ });
  await choose.focus(); const chooser = page.waitForEvent("filechooser"); await choose.press("Enter");
  await (await chooser).setFiles([image("first.png"), image("second.png")]);
  const trigger = page.getByRole("button", { name: "Files (2)", exact: true });
  await trigger.click(); const dialog = page.getByRole("dialog", { name: "Screenshots", exact: true });
  await expect(page.getByTestId("file-list")).toHaveCount(1);
  await expect(dialog.getByTestId("file-item").first()).toContainText("first.png");
  await dialog.getByRole("button", { name: "Move first.png down", exact: true }).click();
  await expect(dialog.getByTestId("file-item").first()).toContainText("second.png");
  await noOverflow(page);
  await dialog.getByRole("button", { name: /^1\. second\.png/ }).focus(); await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await trigger.click(); await expect(dialog.getByTestId("file-item").first()).toContainText("second.png");
});

test("switch names stay concise with separately associated help and 44px mobile targets", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await upload(page, "/compare-screenshots", [image("a.png"), image("b.png")]);
  await page.getByTestId("mobile-inspector-trigger").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Difference", exact: true }).click();
  await dialog.getByRole("button", { name: "Noise and colour", exact: true }).click();
  const toggle = dialog.getByRole("switch", { name: "Ignore anti-aliasing", exact: true });
  await expect(toggle).toHaveAccessibleDescription(/Whole-pixel shifts remain visible/);
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await toggle.boundingBox())!.width).toBeGreaterThanOrEqual(44);
  await toggle.focus(); const checked = await toggle.getAttribute("aria-checked");
  await toggle.press("Space"); await expect(toggle).toHaveAttribute("aria-checked", checked === "true" ? "false" : "true");
  await noOverflow(page);
});
