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
  /**
   * The language can be STUDIED (offered as a learning language). Every supported
   * language can still be translated to/from and act as a native language; this only
   * gates what a user can pick to learn. Product decision 2026-11-07: Japanese only
   * for now — the English-learning path (EN→JA meanings, CEFR leveling) isn't good
   * enough to offer yet. Re-enabling English is flipping this flag, nothing else.
   */
  learnable?: boolean;
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
    learnable: true,
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
    // Not learnable (yet): see `learnable` above.
  },
];

/** The languages a user may pick to LEARN (a subset of SUPPORTED_LANGUAGES, never empty). */
export const LEARNABLE_LANGUAGES: LanguageDefinition[] = SUPPORTED_LANGUAGES.filter((l) => l.learnable);

/** A language's display name, or the code itself when it isn't in the registry. */
export function languageName(code: LangCode): string {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

/**
 * True while the direction pickers (Translate, the Lists add-word form) should be a
 * fixed pair + ⇄ rather than dropdowns: with only two languages a dropdown has nothing
 * to offer that the swap doesn't. A third language turns the dropdowns back on.
 */
export const FIXED_LANGUAGE_PAIR = SUPPORTED_LANGUAGES.length <= 2;

/** True if `code` can be studied. */
export function isLearnable(code: string): boolean {
  return LEARNABLE_LANGUAGES.some((l) => l.code === code);
}

/** Language returned by auto-detect when no script-specific matcher claims the text. */
export const DEFAULT_LANGUAGE: LangCode = "EN";

/**
 * The LAST-RESORT pair, for when the device's language can't be read or isn't one we
 * support. DEFAULT_LEARNING_LANGUAGE must be learnable. A user who hasn't set a pair on the Profile page gets `defaultLanguagePair()`
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
 * The learning language for someone whose native language is `native`: the first
 * learnable language that isn't it, else the first learnable language at all (a
 * native speaker of the only learnable language still gets a valid pair — the
 * native side is then moved off it by `nativeFor`).
 */
function learningFor(native: LangCode | null): LangCode {
  return (LEARNABLE_LANGUAGES.find((l) => l.code !== native) ?? LEARNABLE_LANGUAGES[0]).code;
}

/** `preferred` as the native side of a pair learning `learning`, unless it collides. */
function nativeFor(learning: LangCode, preferred: LangCode | null): LangCode {
  return preferred && preferred !== learning ? preferred : otherLanguage(learning);
}

/**
 * The pair for a user who has saved neither language: LEARNING is a learnable
 * language other than the device's, NATIVE is the device's language (English when the
 * device is in something we don't support, or in the language being learned). While
 * Japanese is the only learnable language, a Japanese device therefore opens on
 * Japanese study explained in English — the UI locale is a separate setting.
 */
export function defaultLanguagePair(): { native: LangCode; learning: LangCode } {
  const system = systemLanguage() ?? DEFAULT_NATIVE_LANGUAGE;
  const learning = learningFor(system);
  return { learning, native: nativeFor(learning, system) };
}

/**
 * A saved profile pair with whatever is unset — or no longer offered — filled in. A
 * saved native always wins unless it collides with the learning side; a saved
 * learning language wins only while it is learnable (a profile saved as "learning
 * English" before English was withdrawn reads as Japanese). The two sides can never
 * be the same language.
 */
export function resolveLanguagePair(
  saved: { learningLanguage: string | null; nativeLanguage: string | null } | null,
): { native: LangCode; learning: LangCode } {
  const savedLearning = saved?.learningLanguage ?? null;
  const savedNative = saved?.nativeLanguage ?? null;
  const learning =
    savedLearning && isLearnable(savedLearning) ? savedLearning : learningFor(savedNative ?? systemLanguage());
  return { learning, native: nativeFor(learning, savedNative ?? systemLanguage() ?? DEFAULT_NATIVE_LANGUAGE) };
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
