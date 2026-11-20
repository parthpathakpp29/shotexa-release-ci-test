import { describe, expect, it, vi } from "vitest";
import { encodeSize, resizePercent, suggestResizePercent } from "@/core/image-encode/geometry";
import { encodeRequestKey, DEFAULT_ENCODE_SETTINGS, normaliseSettings } from "@/core/image-encode/settings";
import { encodeIssue } from "@/core/image-encode/limits";
import { EncodeSession } from "@/core/image-encode/session";
import { searchTargetSize } from "@/core/image-encode/target-size";

describe("explicit compressor dimensions", () => {
  it("defaults to original dimensions and normalizes only an explicit resize", () => {
    expect(encodeSize({ width: 1001, height: 603 })).toEqual({ width: 1001, height: 603 });
    expect(encodeSize({ width: 1001, height: 603 }, 50)).toEqual({ width: 501, height: 302 });
    expect(resizePercent(undefined)).toBe(100);
    expect(normaliseSettings({ ...DEFAULT_ENCODE_SETTINGS.compress, resizePercent: 1 }).resizePercent).toBe(10);
    expect(suggestResizePercent(100, 4000, 1000)).toBe(47);
    expect(suggestResizePercent(10, 4000, 1000)).toBeNull();
  });
  it("can reduce output limits without bypassing original-image memory limits", () => {
    expect(encodeIssue({ width: 1000, height: 17000 }, "webp")).toBe("format-dimension");
    expect(encodeIssue({ width: 1000, height: 17000 }, "webp", true, 50)).toBeNull();
    expect(encodeIssue({ width: 10000, height: 10000 }, "jpeg", true, 10)).toBe("source-too-large");
  });
  it("keys actual output choices while ignoring irrelevant PNG quality and background", () => {
    const file = { type: "image/png", width: 800, height: 600 };
    const initial = { ...DEFAULT_ENCODE_SETTINGS.compress };
    const key = encodeRequestKey("compress", "a", file, initial);
    expect(encodeRequestKey("compress", "a", file, { ...initial, quality: 1, background: "#000000" })).toBe(key);
    expect(encodeRequestKey("compress", "a", file, { ...initial, resizePercent: 50 })).not.toBe(key);
    expect(encodeRequestKey("compress", "b", file, initial)).not.toBe(key);
  });
});

describe("bounded local encode session", () => {
  it("deduplicates work and reuses the measured Blob", async () => {
    const session = new EncodeSession();
    const source = new Blob(["source"]);
    const result = new Blob(["output"]);
    const work = vi.fn(async () => result);
    const a = session.run("same", source, work, (blob) => blob.size);
    const b = session.run("same", source, work, (blob) => blob.size);
    expect(a).toBe(b);
    expect(await a).toBe(result);
    expect(await session.run("same", source, work, (blob) => blob.size)).toBe(result);
    expect(work).toHaveBeenCalledTimes(1);
    session.clear();
    expect(session.stats()).toEqual({ entries: 0, bytes: 0 });
  });
  it("serializes superseding requests and rejects the old result", async () => {
    const session = new EncodeSession();
    const source = new Blob(["source"]);
    let finish!: (blob: Blob) => void;
    const old = session.run("old", source, () => new Promise<Blob>((resolve) => { finish = resolve; }), (blob) => blob.size);
    const rejected = expect(old).rejects.toMatchObject({ code: "ENCODE_CANCELLED" });
    await vi.waitFor(() => expect(finish).toBeDefined());
    const newerWork = vi.fn(async () => new Blob(["new"]));
    const newer = session.run("new", source, newerWork, (blob) => blob.size);
    expect(newerWork).not.toHaveBeenCalled();
    finish(new Blob(["old"]));
    await rejected;
    expect(await (await newer).text()).toBe("new");
    expect(session.peek("old", source)).toBeUndefined();
  });
  it("cancels without caching late output and forgets removed source files", async () => {
    const session = new EncodeSession(10, 2);
    const source = new Blob(["source"]);
    const controller = new AbortController();
    const output = session.run("a", source, async () => { controller.abort(); return new Blob(["late"]); }, (blob) => blob.size, controller.signal);
    await expect(output).rejects.toMatchObject({ code: "ENCODE_CANCELLED" });
    expect(session.stats().entries).toBe(0);
    session.remember("a", source, 1, 6);
    session.remember("b", source, 2, 6);
    expect(session.peek("a", source)).toBeUndefined();
    session.remember("huge", source, 3, 11);
    expect(session.peek("huge", source)).toBeUndefined();
    session.forget(source);
    expect(session.stats().entries).toBe(0);
  });
});

describe("target search cancellation and progress", () => {
  it("never encodes the same quality twice and reports increasing attempt counts", async () => {
    const qualities: number[] = [], attempts: number[] = [];
    const result = await searchTargetSize(1, 1, async (quality) => { qualities.push(quality); return 10000; }, { onAttempt: (attempt) => attempts.push(attempt) });
    expect(result.metTarget).toBe(false);
    expect(qualities).toContain(0.5);
    expect(new Set(qualities).size).toBe(qualities.length);
    expect(attempts).toEqual(attempts.map((_value, i) => i + 1));
  });
  it("checks cancellation after an encoder returns before accepting its result", async () => {
    const controller = new AbortController();
    await expect(searchTargetSize(100, 1, async () => { controller.abort(); return 50; }, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "ENCODE_CANCELLED" });
  });
});
