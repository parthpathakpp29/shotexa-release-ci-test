/** Console failures relevant to local previews and the shared worker bootstrap. */
export function isPreviewConsoleError(level: string, text: string): boolean {
  return level === "error" && /\bblob:|\bturbopack-worker-/i.test(text);
}
