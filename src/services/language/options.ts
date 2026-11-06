// =========================================================
// UI view-model helpers: dropdown options built from the registry.
// Keeps presentation shaping out of the registry and detection modules.
// Quickly access all supported languages
// =========================================================

import { SUPPORTED_LANGUAGES, LEARNABLE_LANGUAGES, type LangCode, type LanguageDefinition } from "./registry";
import { AUTO_DETECT, type SourceSelection } from "./detect";

/**
 * Options for the TARGET dropdown: every supported language.
 * OUTPUT: LanguageDefinition[] (all supported languages).
 * CONSTRAINTS: none.
 */
export function targetOptions(): LanguageDefinition[] {
  return SUPPORTED_LANGUAGES;
}

/**
 * Options for the Profile's LEARNING dropdown: only the languages that can be studied.
 * (Translate's own direction dropdowns stay on every supported language — looking a
 * word up in either direction is still useful while learning only one.)
 */
export function learningOptions(): LanguageDefinition[] {
  return LEARNABLE_LANGUAGES;
}

/** Options for the Profile's NATIVE dropdown: every supported language except the one being learned. */
export function nativeOptions(learning: LangCode): LanguageDefinition[] {
  return SUPPORTED_LANGUAGES.filter((l) => l.code !== learning);
}

/**
 * Options for the SOURCE dropdown: "Detect language" first, then every language.
 * OUTPUT: {code, name}[] — the first entry's code is the AUTO_DETECT sentinel.
 * CONSTRAINTS: callers must resolve AUTO_DETECT to a concrete code before translating.
 */
export function sourceOptions(): Array<{ code: SourceSelection; name: string }> {
  return [
    { code: AUTO_DETECT, name: "Detect language" },
    ...SUPPORTED_LANGUAGES.map((l) => ({ code: l.code, name: l.name })),
  ];
}

/**
 * Flip a translate direction (the ⇄ button), shared by every surface that offers
 * one so they can't drift. The (concrete) target becomes the source; the new
 * target is the old source when it was concrete, else the other supported language
 * — so we never land on source === target, and "Detect" (which the target slot has
 * no option for) never ends up there.
 *
 * OUTPUT: the flipped pair. PURE.
 */
export function swapLanguages(
  source: SourceSelection,
  target: LangCode
): { source: SourceSelection; target: LangCode } {
  return {
    source: target,
    target:
      source !== AUTO_DETECT
        ? source
        : SUPPORTED_LANGUAGES.find((l) => l.code !== target)?.code ?? target,
  };
}
