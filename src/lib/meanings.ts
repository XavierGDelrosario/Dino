/** "cat; feline; puss" → one entry per sense, never the raw squished run. */
export function splitMeanings(translation: string): string[] {
  return translation
    .split(";")
    .map((m) => m.trim())
    .filter(Boolean);
}
