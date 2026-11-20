import { describe, expect, it } from "vitest";
import { convertSvg } from "@/core/conversion/svg";

describe("SVG raster output dimensions", () => {
  it.each([[12.5, 20], [12, 20.5]])("rejects %s × %s before allocating a canvas", async (width, height) => {
    await expect(convertSvg("<svg/>", width, height, "png")).rejects.toThrow("Use whole pixels for width and height.");
  });
});
