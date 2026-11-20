import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMetadataClean } from "@/core/metadata/run";
import { renderSafeShare } from "@/core/redaction/render";
import { FIXTURE_DIR } from "../../helpers/stitch-fixtures";

vi.mock("@/core/metadata/run", () => ({ runMetadataClean: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

function setup(type = "image/png", metadataPassed = true) {
  const png = readFileSync(join(FIXTURE_DIR, "chat-light/a.png"));
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width, height, close })));
  const canvas = {
    width, height,
    getContext: () => ({ drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: "" }),
    toBlob: (callback: BlobCallback) => callback(new Blob([png], { type: "image/png" })),
  } as unknown as OffscreenCanvas;
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.mocked(runMetadataClean).mockResolvedValue({
    output: new Blob([png], { type }),
    verification: { passed: metadataPassed, unexpectedRemainingPrivacyMetadata: [], removedCategories: [] },
  } as unknown as Awaited<ReturnType<typeof runMetadataClean>>);
  return { input: new Blob([png], { type: "image/png" }), canvas, close };
}

describe("redaction renderer output verification", () => {
  it("rejects a final MIME mismatch and releases decoded and canvas resources", async () => {
    const { input, canvas, close } = setup("image/jpeg");
    await expect(renderSafeShare(input, [{ id: "r", assetId: "source", mode: "blackout", rect: { x: 10, y: 20, width: 100, height: 80 }, intensity: 1 }], {
      format: "png", createCanvas: () => canvas,
    })).rejects.toMatchObject({ code: "REDACTION_VERIFY_FAILED" });
    expect(close).toHaveBeenCalledTimes(2);
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });

  it("rejects failed metadata verification", async () => {
    const { input, canvas } = setup("image/png", false);
    await expect(renderSafeShare(input, [{ id: "r", assetId: "source", mode: "blackout", rect: { x: 10, y: 20, width: 100, height: 80 }, intensity: 1 }], {
      format: "png", createCanvas: () => canvas,
    })).rejects.toMatchObject({ code: "REDACTION_VERIFY_FAILED" });
  });

  it("returns all verification flags only after output checks pass", async () => {
    const { input, canvas } = setup();
    const result = await renderSafeShare(input, [{ id: "r", assetId: "source", mode: "blackout", rect: { x: 10, y: 20, width: 100, height: 80 }, intensity: 1 }], {
      format: "png", createCanvas: () => canvas,
    });
    expect(result.verification).toEqual({ redactionsFlattened: true, privacyMetadataRemoved: true, outputVerified: true, dimensionsMatch: true, formatMatch: true });
  });
});
