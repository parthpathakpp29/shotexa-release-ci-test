import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PDF_BYTES, openPdf, planPdfPages, renderPdfPage, type LocalPdf } from "@/core/conversion/pdf-images";

const fake = vi.hoisted(() => ({ getDocument: vi.fn(), GlobalWorkerOptions: { workerSrc: "" } }));
vi.mock("pdfjs-dist", () => fake);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); fake.getDocument.mockReset(); });
function documentWithSize(width = 200, height = 100) {
  const page = { getViewport: vi.fn(({ scale }) => ({ width: width * scale, height: height * scale })), cleanup: vi.fn(), render: vi.fn() };
  const doc = { numPages: 80, getPage: vi.fn(async () => page), destroy: vi.fn(async () => undefined) };
  return { doc: doc as unknown as LocalPdf, page };
}
describe("PDF geometry and lifecycle", () => {
  it.each([1, 10, 40, 80])("plans %i pages without rendering or changing page order", async (count) => {
    const { doc, page } = documentWithSize(); const pages = Array.from({ length: count }, (_, i) => i + 1);
    const plan = await planPdfPages(doc, pages, 1.5);
    expect(plan.sizes.map((p) => p.page)).toEqual(pages); expect(plan.sizes[0]).toMatchObject({ width: 300, height: 150 });
    expect(page.render).not.toHaveBeenCalled(); expect(page.cleanup).toHaveBeenCalledTimes(count);
  });
  it("refuses oversized pages and selections before rendering, with cleanup", async () => {
    const large = documentWithSize(10000, 10000); await expect(planPdfPages(large.doc, [1], 1)).rejects.toThrow("too large"); expect(large.page.cleanup).toHaveBeenCalled();
    const many = documentWithSize(2000, 2000); await expect(planPdfPages(many.doc, Array.from({ length: 21 }, (_, i) => i + 1), 1)).rejects.toThrow("80 million"); expect(many.page.render).not.toHaveBeenCalled();
  });
  it("checks cancellation before allocation", async () => {
    const { doc } = documentWithSize(); const abort = new AbortController(); abort.abort();
    await expect(planPdfPages(doc, [1], 1, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(renderPdfPage(doc, 1, 1, "png", 1, abort.signal)).rejects.toMatchObject({ name: "AbortError" }); expect(doc.getPage).not.toHaveBeenCalled();
  });
  it("cancels the real render-task boundary and releases canvas and page", async () => {
    const { doc, page } = documentWithSize(); const abort = new AbortController();
    let fail!: (cause: unknown) => void;
    const task = { promise: new Promise<void>((_, reject) => { fail = reject; }), cancel: vi.fn(() => fail(new Error("RenderingCancelled"))) };
    page.render.mockReturnValue(task);
    const canvas = { width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect: vi.fn() }) };
    vi.stubGlobal("document", { createElement: () => canvas });
    const work = renderPdfPage(doc, 1, 2, "jpg", .92, abort.signal); await vi.waitFor(() => expect(page.render).toHaveBeenCalled());
    abort.abort(); await expect(work).rejects.toMatchObject({ name: "AbortError" });
    expect(task.cancel).toHaveBeenCalled(); expect(page.cleanup).toHaveBeenCalled(); expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });
  it("rejects file/page limits and damaged/password PDFs understandably", async () => {
    await expect(openPdf(new File(["x"], "bad.pdf"))).rejects.toThrow("60 MB");
    expect(MAX_PDF_BYTES).toBe(60 * 1024 * 1024);
    const file = new File(["%PDF-1.7\nvalid header"], "test.pdf");
    const destroy = vi.fn(async () => undefined);
    fake.getDocument.mockReturnValueOnce({ promise: Promise.resolve({ numPages: 81, destroy }), destroy });
    await expect(openPdf(file)).rejects.toThrow("more than 80"); expect(destroy).toHaveBeenCalled();
    fake.getDocument.mockReturnValueOnce({ promise: Promise.reject(new Error("Password protected")), destroy });
    await expect(openPdf(file)).rejects.toThrow("password protected");
    fake.getDocument.mockReturnValueOnce({ promise: Promise.reject(new Error("Invalid PDF")), destroy });
    await expect(openPdf(file)).rejects.toThrow("could not be opened");
  });
  it("cancels loading, destroys its task, and reports cancellation rather than damage", async () => {
    let fail!: (cause: unknown) => void; const abort = new AbortController();
    const destroy = vi.fn(async () => { fail(new Error("Loading stopped")); });
    fake.getDocument.mockReturnValue({ promise: new Promise((_, reject) => { fail = reject; }), destroy });
    const work = openPdf(new File(["%PDF-1.7\nvalid header"], "test.pdf"), { signal: abort.signal });
    await vi.waitFor(() => expect(fake.getDocument).toHaveBeenCalled()); abort.abort();
    await expect(work).rejects.toMatchObject({ name: "AbortError" }); expect(destroy).toHaveBeenCalled();
  });
});
