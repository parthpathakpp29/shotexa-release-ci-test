/** Explicit downscaling only. The original decode still counts against the memory budget. */
export function resizePercent(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? 100 : Math.max(10, Math.min(100, Math.round(value)));
}

export function encodeSize(source: { width: number; height: number }, percent = 100) {
  const scale = resizePercent(percent) / 100;
  return { width: Math.max(1, Math.round(source.width * scale)), height: Math.max(1, Math.round(source.height * scale)) };
}

/** A starting point to offer for consent, never a promise that the next encode will fit. */
export function suggestResizePercent(current: number, outputBytes: number, targetBytes: number): number | null {
  const value = resizePercent(current);
  if (value <= 10 || targetBytes <= 0 || outputBytes <= targetBytes) return null;
  return Math.max(10, Math.min(value - 1, Math.floor(value * Math.sqrt(targetBytes / outputBytes) * 0.95)));
}
