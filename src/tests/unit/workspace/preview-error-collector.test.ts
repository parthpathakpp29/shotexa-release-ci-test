import { describe, expect, it } from "vitest";
import { isPreviewConsoleError } from "../../helpers/preview-errors";

describe("preview console error collection", () => {
  it.each([
    ["error", "Cannot load blob:http://localhost/preview due to access control checks.", true],
    ["error", "Cannot load http://localhost/_next/static/chunks/turbopack-worker-entry.js due to access control checks.", true],
    ["warning", "Cannot load blob:http://localhost/preview", false],
    ["error", "Fetch API cannot load http://localhost/tools?_rsc=abc", false],
    ["error", "unrelated diagnostic", false],
    ["error", "notablob:http://localhost/preview", false],
  ] as const)("%s: %s → %s", (level, text, expected) => {
    expect(isPreviewConsoleError(level, text)).toBe(expected);
  });
});
