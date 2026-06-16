// =========================================================
// The set of supported languages
//
// To add a language, append one entry with a script matcher. Detection
// (detect.ts) and the UI dropdowns (options.ts) pick it up automatically.
// =========================================================

/** ISO-639-1-style language code, uppercased. e.g. "EN", "JA". */
export type LangCode = string;

export interface LanguageDefinition {
  code: LangCode;
  name: string;
  /**
   * Returns true if `text` is written in this language's script. Used only for
   * auto-detect. Omit for a fallback language (e.g. Latin-script English),
   * which is detected only when no script-specific language claims the text.
   */
  matches?: (text: string) => boolean;
}

/** Builds a script matcher from inclusive Unicode code-point ranges. */
function scriptMatcher(ranges: Array<[number, number]>): (text: string) => boolean {
  return (text: string): boolean => {
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      for (const [lo, hi] of ranges) {
        if (cp >= lo && cp <= hi) return true;
      }
    }
    return false;
  };
}

// ---------------------------------------------------------------------------
// Registry — add a language by adding an entry here.
// ---------------------------------------------------------------------------
export const SUPPORTED_LANGUAGES: LanguageDefinition[] = [
  {
    code: "JA",
    name: "Japanese",
    matches: scriptMatcher([
      [0x3040, 0x30ff], // Hiragana + Katakana
      [0x3400, 0x4dbf], // CJK Extension A
      [0x4e00, 0x9fff], // CJK Unified Ideographs (Kanji)
      [0xff66, 0xff9f], // Halfwidth Katakana
    ]),
  },
  {
    code: "EN",
    name: "English",
    // No matcher: Latin-script English is the detection fallback.
  },
];

/** Language returned by auto-detect when no script-specific matcher claims the text. */
export const DEFAULT_LANGUAGE: LangCode = "EN";

/**
 * True if `code` is a supported language.
 * OUTPUT: boolean.
 * CONSTRAINTS: case-sensitive exact match against the registry (e.g. "EN").
 */
export function isSupported(code: string): boolean {
  return SUPPORTED_LANGUAGES.some((l) => l.code === code);
}
