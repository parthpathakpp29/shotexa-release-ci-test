import { EncodeError } from "./types";

/** Local coordination: serialize encode work and bound retained results, outside UI state. */
export class EncodeSession {
  private tail: Promise<void> = Promise.resolve();
  private active: { key: string; source: Blob; abort: AbortController; promise: Promise<unknown> } | null = null;
  private cache = new Map<string, { source: Blob; value: unknown; bytes: number }>();
  constructor(private maxBytes = 32 * 1024 * 1024, private maxEntries = 4) {}

  peek<T>(key: string, source: Blob): T | undefined {
    const entry = this.cache.get(key);
    if (!entry || entry.source !== source) return undefined;
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value as T;
  }

  remember<T>(key: string, source: Blob, value: T, bytes: number) {
    this.cache.delete(key);
    if (!Number.isFinite(bytes) || bytes > this.maxBytes || bytes < 0) return;
    this.cache.set(key, { source, value, bytes });
    while (this.cache.size > this.maxEntries || this.stats().bytes > this.maxBytes) this.cache.delete(this.cache.keys().next().value!);
  }

  run<T>(key: string, source: Blob, work: (signal: AbortSignal) => Promise<T>, bytes: (value: T) => number, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new EncodeError("ENCODE_CANCELLED"));
    const cached = this.peek<T>(key, source);
    if (cached !== undefined) {
      if (this.active?.key !== key) this.cancel();
      return Promise.resolve(cached);
    }
    if (this.active?.key === key && this.active.source === source && !this.active.abort.signal.aborted) return this.active.promise as Promise<T>;
    this.cancel();
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const promise = this.tail.then(async () => {
      if (abort.signal.aborted) throw new EncodeError("ENCODE_CANCELLED");
      const value = await work(abort.signal);
      if (abort.signal.aborted) throw new EncodeError("ENCODE_CANCELLED");
      this.remember(key, source, value, bytes(value));
      return value;
    }).finally(() => {
      signal?.removeEventListener("abort", cancel);
      if (this.active?.abort === abort) this.active = null;
    });
    this.active = { key, source, abort, promise };
    this.tail = promise.then(() => undefined, () => undefined);
    return promise;
  }

  cancel() { this.active?.abort.abort(); }
  forget(source: Blob | undefined) {
    if (!source) return;
    if (this.active?.source === source) this.cancel();
    for (const [key, entry] of this.cache) if (entry.source === source) this.cache.delete(key);
  }
  clear() { this.cancel(); this.cache.clear(); }
  stats() { return { entries: this.cache.size, bytes: [...this.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0) }; }
}
