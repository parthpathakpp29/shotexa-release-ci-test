import type { BatchResult } from "@/core/batch/types";
import { MAX_BATCH_OUTPUT_BYTES } from "@/core/batch/types";
import { uniqueOutputNames } from "@/core/batch/naming";

export class ArchiveError extends Error {
  constructor(readonly code: "ZIP_EMPTY" | "ZIP_TOO_LARGE" | "ZIP_CREATE_FAILED" | "ZIP_CANCELLED", detail?: string) {
    super(detail ?? code);
    this.name = "ArchiveError";
  }
}

export interface ArchiveEntry {
  name: string;
  input: Blob | string;
  size?: number;
}

export interface ArchiveOptions { signal?: AbortSignal; onProgress?(fraction: number): void }
/** A real input/paint opportunity without background-page timer clamping. Ports are task-local. */
async function yieldArchive() {
  if (typeof MessageChannel === "undefined") { await new Promise<void>((resolve) => setTimeout(resolve, 0)); return; }
  const channel = new MessageChannel();
  try { await new Promise<void>((resolve) => { channel.port1.onmessage = () => resolve(); channel.port2.postMessage(null); }); }
  finally { channel.port1.close(); channel.port2.close(); }
}
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new ArchiveError("ZIP_CANCELLED"); };
const normalise = (entries: ArchiveEntry[]) => {
  const names = uniqueOutputNames(entries.map((entry) => entry.name));
  return entries.map((entry, index) => {
    const input = typeof entry.input === "string" ? new Blob([entry.input], { type: "text/plain;charset=utf-8" }) : entry.input;
    // The Blob is authoritative; a caller's size hint must never bypass the buffering limit.
    return { name: names[index], input, size: input.size, lastModified: new Date(0) };
  });
};

/** client-zip's own exact forecast includes UTF-8 names and ZIP records, without reading pixels. */
export async function planZip(entries: ArchiveEntry[]) {
  const files = normalise(entries);
  const { predictLength } = await import("client-zip");
  const bytes = Number(predictLength(files.map(({ name, size }) => ({ name, size }))));
  return { bytes, names: files.map((file) => file.name), withinLimit: bytes <= MAX_BATCH_OUTPUT_BYTES };
}

/** Generic local ZIP creation shared by Batch and workflow packages. */
export async function createZip(entries: ArchiveEntry[], options: ArchiveOptions = {}): Promise<{ blob: Blob; names: string[] }> {
  check(options.signal);
  if (!entries.length) throw new ArchiveError("ZIP_EMPTY");
  const normalised = normalise(entries);
  const total = normalised.reduce((sum, entry) => sum + entry.size, 0);
  if (total > MAX_BATCH_OUTPUT_BYTES) throw new ArchiveError("ZIP_TOO_LARGE");
  try {
    const { makeZip, predictLength } = await import("client-zip");
    check(options.signal);
    const bytes = Number(predictLength(normalised.map(({ name, size }) => ({ name, size }))));
    if (bytes > MAX_BATCH_OUTPUT_BYTES) throw new ArchiveError("ZIP_TOO_LARGE");
    // Cancel native Blob readers directly too: a downstream ZIP stream cancellation alone
    // does not guarantee that a library releases an input reader suspended inside a generator.
    const sources = new Set<ReadableStreamDefaultReader<Uint8Array>>();
    async function* input(blob: Blob) {
      const source = blob.stream().getReader(); sources.add(source);
      try {
        while (true) {
          check(options.signal);
          const { done, value } = await source.read();
          check(options.signal);
          if (done) break;
          yield value;
        }
      } finally { sources.delete(source); await source.cancel().catch(() => undefined); source.releaseLock(); }
    }
    const reader = makeZip(normalised.map((file) => ({ ...file, input: input(file.input) }))).getReader();
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cancel = () => {
      output?.error(new ArchiveError("ZIP_CANCELLED"));
      for (const source of sources) void source.cancel().catch(() => undefined);
      void reader.cancel().catch(() => undefined);
    };
    let loaded = 0, count = 0;
    // Let the browser collect the stream into its Blob implementation. Do not retain a
    // second archive-sized JavaScript array of all Uint8Array chunks before creating a Blob.
    const bounded = new ReadableStream<Uint8Array>({
      start(controller) { output = controller; },
      async pull(controller) {
        check(options.signal);
        const { done, value } = await reader.read();
        check(options.signal);
        if (done) { controller.close(); return; }
        loaded += value.byteLength;
        if (loaded > MAX_BATCH_OUTPUT_BYTES) throw new ArchiveError("ZIP_TOO_LARGE");
        controller.enqueue(value);
        if (++count % 8 === 0) { options.onProgress?.(loaded / bytes); await yieldArchive(); }
      },
      cancel: () => reader.cancel(),
    });
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      options.onProgress?.(0); check(options.signal);
      const blob = await new Response(bounded, { headers: { "Content-Type": "application/zip" } }).blob();
      check(options.signal);
      if (blob.size !== bytes) throw new ArchiveError("ZIP_CREATE_FAILED");
      options.onProgress?.(1); check(options.signal);
      return { blob, names: normalised.map((file) => file.name) };
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => undefined);
      for (const source of sources) { await source.cancel().catch(() => undefined); source.releaseLock(); }
      sources.clear(); reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    check(options.signal);
    throw new ArchiveError("ZIP_CREATE_FAILED", error instanceof Error ? error.message : undefined);
  }
}

export async function createBatchZip(results: BatchResult[], options: ArchiveOptions = {}): Promise<{ blob: Blob; names: string[] }> {
  if (!results.length) throw new ArchiveError("ZIP_EMPTY");
  const total = results.reduce((n, r) => n + r.blob.size, 0);
  if (total > MAX_BATCH_OUTPUT_BYTES) throw new ArchiveError("ZIP_TOO_LARGE");
  const names = uniqueOutputNames(results.map((r) => r.outputName));
  return createZip(results.map((result, index) => ({ name: names[index], input: result.blob, size: result.blob.size })), options);
}
