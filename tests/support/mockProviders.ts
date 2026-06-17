// =========================================================
// Mock translation / sense providers for tests.
//
// The production provider is server-only and unimplemented (the `translate`
// edge function's callTranslationProvider throws; the senses registry is empty
// so everything falls back to single-sense MT). These mocks stand in for a
// real provider so the read/write flows can be tested deterministically:
//
//   createMockSenseProvider(words)  — a SenseProvider returning ALL matching
//       senses (verified first) for a word+pair, like a real dictionary would.
//       This is the multi-sense behaviour the empty registry can't yet provide.
//   createMockTranslate(words)      — a stand-in for translation/client.translate
//       that serves a single preferred sense from the seed set and honours the
//       persist flag (persist:false → display-only, word:null), mirroring the
//       edge function's contract.
//
// Both serve from a caller-supplied word set (default: FIXTURE_WORDS).
// =========================================================
import type { Word } from "@/services/words/repository";
import type { LangCode } from "@/services/language";
import type { SenseProvider } from "@/services/senses";
import type { TranslationResult } from "@/services/translation";
import { FIXTURE_WORDS } from "./fixtures";

const norm = (s: string) => s.trim().normalize("NFC");

/** All seeded senses for a word+pair, verified first (real-dictionary shape). */
function sensesFor(
  words: Word[],
  input: string,
  sourceLang: LangCode,
  targetLang: LangCode
): Word[] {
  const key = norm(input);
  return words
    .filter(
      (w) =>
        w.input === key &&
        w.sourceLang === sourceLang &&
        w.targetLang === targetLang
    )
    .sort((a, b) => Number(b.isVerified) - Number(a.isVerified));
}

/**
 * A SenseProvider backed by `words`. Returns every matching sense — so 高い
 * comes back with both "high" and "expensive" — letting tests cover the
 * multi-sense path. Returns [] for an unknown word.
 */
export function createMockSenseProvider(words: Word[] = FIXTURE_WORDS): SenseProvider {
  return async (word, sourceLang, targetLang) =>
    sensesFor(words, word, sourceLang, targetLang);
}

/**
 * A stand-in for translate(): serves the PREFERRED (first) seeded sense.
 * - hit  → { translated: true, translation, word } (word:null when persist:false)
 * - miss → { translated: false, translation: null, word: null }
 */
export function createMockTranslate(words: Word[] = FIXTURE_WORDS) {
  return async (params: {
    input: string;
    sourceLang: LangCode;
    targetLang: LangCode;
    persist?: boolean;
  }): Promise<TranslationResult> => {
    const [preferred] = sensesFor(
      words,
      params.input,
      params.sourceLang,
      params.targetLang
    );
    if (!preferred) {
      return { translated: false, translation: null, word: null };
    }
    return {
      translated: true,
      translation: preferred.translation,
      word: params.persist === false ? null : preferred,
    };
  };
}
