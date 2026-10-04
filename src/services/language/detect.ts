// =========================================================
// Language detection and source resolution (Google-Translate-style).
//
// The UI source dropdown offers a concrete language or "Detect language"
// (AUTO_DETECT). resolveSourceLanguage turns that selection into a concrete
// language, detecting from the text only when the user left it on auto.
// =========================================================

import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, type LangCode } from "./registry";

/** Sentinel for the source dropdown's "Detect language" option. */
export const AUTO_DETECT = "auto" as const;

/** A source selection: a concrete language, or auto-detect. */
export type SourceSelection = LangCode | typeof AUTO_DETECT;

/**
 * Detects the language of `text` by walking the registry and returning the
 * first language whose script matcher claims it; falls back to DEFAULT_LANGUAGE.
 *
 * OUTPUT: a concrete LangCode.
 * CONSTRAINTS: script-based only — cannot tell apart same-script languages;
 * falls back to DEFAULT_LANGUAGE when nothing matches.
 *
 * TODO: this only differentiates languages by script, failing in a case of many supported languages sharing
 * the same script (e.g. English vs Spanish).
 */
export function detectLanguage(text: string): LangCode {
  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang.matches?.(text)) {
      return lang.code;
    }
  }
  return DEFAULT_LANGUAGE;
}

/** Does `text` contain anything written in `lang`'s script? A language with no script
 *  matcher of its own (the Latin default) is recognised by a Latin letter. */
function hasScriptOf(lang: LangCode, text: string): boolean {
  const matches = SUPPORTED_LANGUAGES.find((l) => l.code === lang)?.matches;
  return matches ? matches(text) : /[A-Za-z]/.test(text);
}

/**
 * Is `text` ALREADY in `target`, with nothing of `source` in it to translate?
 *
 * detectLanguage alone is not this question: it reports the first script it sees, so
 * ONE kana/kanji/hanzi character makes a whole English article "Japanese" — a name in
 * brackets, 「Shinzo Abe (安倍晋三)」, was enough to echo the article back unanalysed for
 * someone learning English. The text is only "already translated" when it reads as the
 * target AND carries nothing in the source's own script.
 */
export function isAlreadyIn(text: string, target: LangCode, source: LangCode): boolean {
  if (source === target) return true;
  return detectLanguage(text) === target && !hasScriptOf(source, text);
}

/**
 * Resolves the UI source selection to a concrete language: detects from `text`
 * when the user left the source on "Detect language", otherwise uses their pick.
 *
 * OUTPUT: a concrete LangCode (never AUTO_DETECT).
 * CONSTRAINTS: detection runs only when selected === AUTO_DETECT.
 */
export function resolveSourceLanguage(
  text: string,
  selected: SourceSelection
): LangCode {
  return selected === AUTO_DETECT ? detectLanguage(text) : selected;
}
