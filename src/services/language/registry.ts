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
  /**
   * The language is also written VERTICALLY (縦書き: columns top→bottom, right→left).
   * Gates the photo scanner's text-direction choice — a language that is only ever
   * horizontal is never asked.
   */
  vertical?: boolean;
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
    vertical: true,
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
 * The LAST-RESORT pair, for when the device's language can't be read or isn't one we
 * support. A user who hasn't set a pair on the Profile page gets `defaultLanguagePair()`
 * below — the device's language as native — not these directly.
 * NATIVE = the language you type in (translate SOURCE); LEARNING = the language you
 * study (TARGET). These are the SINGLE source of truth shared by the Profile page's
 * dropdowns and the translate hook, so the input language always matches what the
 * Profile shows — even before the user ever touches the setting.
 */
export const DEFAULT_NATIVE_LANGUAGE: LangCode = "EN";
export const DEFAULT_LEARNING_LANGUAGE: LangCode = "JA";

/** The device's language as a supported code, or null (unsupported, or no browser). */
export function systemLanguage(): LangCode | null {
  if (typeof navigator === "undefined") return null;
  const tag = navigator.languages?.[0] ?? navigator.language ?? "";
  const code = tag.slice(0, 2).toUpperCase();
  return SUPPORTED_LANGUAGES.some((l) => l.code === code) ? code : null;
}

/**
 * The supported language that ISN'T `lang`.
 *
 * ⚠️ Only meaningful while there are exactly TWO supported languages — "the other one"
 * is how a pair is completed today. A third language makes this a guess (it would hand
 * back whichever is listed first), so adding one means replacing every caller with a
 * real choice: see docs/TODO.md (Cross-cutting).
 */
export function otherLanguage(lang: LangCode): LangCode {
  return SUPPORTED_LANGUAGES.find((l) => l.code !== lang)?.code ?? lang;
}

/**
 * The pair for a user who has saved neither language: NATIVE is the device's language
 * (English when the device is in something we don't support), and LEARNING is the
 * other one. So a phone in Japanese opens on English study, explained in Japanese,
 * with no setup.
 */
export function defaultLanguagePair(): { native: LangCode; learning: LangCode } {
  const native = systemLanguage() ?? DEFAULT_NATIVE_LANGUAGE;
  return { native, learning: otherLanguage(native) };
}

/**
 * A saved profile pair with whatever is unset filled in. A saved value always wins;
 * a missing side is completed so the two can never be the same language.
 */
export function resolveLanguagePair(
  saved: { learningLanguage: string | null; nativeLanguage: string | null } | null,
): { native: LangCode; learning: LangCode } {
  const learning = saved?.learningLanguage ?? null;
  const native = saved?.nativeLanguage ?? null;
  if (learning && native) return { native, learning };
  if (native) return { native, learning: otherLanguage(native) };
  if (learning) {
    const system = systemLanguage() ?? DEFAULT_NATIVE_LANGUAGE;
    return { learning, native: system !== learning ? system : otherLanguage(learning) };
  }
  return defaultLanguagePair();
}

/**
 * True if `code` is a supported language.
 * OUTPUT: boolean.
 * CONSTRAINTS: case-sensitive exact match against the registry (e.g. "EN").
 */
export function isSupported(code: string): boolean {
  return SUPPORTED_LANGUAGES.some((l) => l.code === code);
}

/** Whether text in this language can run vertically (unknown codes: no). */
export function canBeVertical(code: LangCode): boolean {
  return SUPPORTED_LANGUAGES.some((l) => l.code === code.toUpperCase() && l.vertical === true);
}
