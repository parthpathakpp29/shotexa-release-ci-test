/** Conservative benchmark normalization: preserve punctuation, case and emoji. */
export const normalizeOcrText = (text: string) => text.normalize("NFC").replace(/\s+/gu, " ").trim();

function distance(a: string[], b: string[]): number {
  if (a.length > b.length) [a, b] = [b, a];
  let previous = Uint32Array.from({ length: a.length + 1 }, (_, i) => i);
  let current = new Uint32Array(a.length + 1);
  for (let j = 1; j <= b.length; j++) {
    current[0] = j;
    for (let i = 1; i <= a.length; i++) current[i] = Math.min(current[i - 1] + 1, previous[i] + 1, previous[i - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [previous, current] = [current, previous];
  }
  return previous[a.length];
}

export function ocrAccuracy(reference: string, actual: string) {
  const expected = normalizeOcrText(reference), recognized = normalizeOcrText(actual);
  const characters = [...expected], words = expected.split(" ").filter(Boolean);
  const characterErrors = distance(characters, [...recognized]);
  const wordErrors = distance(words, recognized.split(" ").filter(Boolean));
  // An empty reference is not a meaningful accuracy denominator.
  return { characterErrors, wordErrors, referenceCharacters: characters.length, referenceWords: words.length, cer: characters.length ? characterErrors / characters.length : null, wer: words.length ? wordErrors / words.length : null };
}
