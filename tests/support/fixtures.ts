// =========================================================
// Seed dictionary entries for tests.
//
// A small in-memory stand-in for the global `words` cache: a handful of
// verified Word rows plus one multi-sense word (高い → high / expensive) so
// tests can exercise the "a word has several meanings" path that the real
// single-sense MT fallback can't produce. The mock providers in
// mockProviders.ts serve translations from this set.
// =========================================================
import type { Word } from "@/services/words/repository";

/** Builds a Word with sensible defaults; override any field per test. */
export function makeWord(overrides: Partial<Word> = {}): Word {
  return {
    wordId: "w-test",
    input: "猫",
    translation: "cat",
    sourceLang: "JA",
    targetLang: "EN",
    isVerified: true,
    createdBy: "system",
    ...overrides,
  };
}

// The seeded dictionary. 高い intentionally has two senses to test multi-sense
// lookup; everything else is single-sense.
export const FIXTURE_WORDS: Word[] = [
  makeWord({ wordId: "ja-neko", input: "猫", translation: "cat" }),
  makeWord({ wordId: "ja-inu", input: "犬", translation: "dog" }),
  makeWord({ wordId: "ja-takai-1", input: "高い", translation: "high" }),
  makeWord({ wordId: "ja-takai-2", input: "高い", translation: "expensive" }),
  makeWord({
    wordId: "en-cat",
    input: "cat",
    translation: "猫",
    sourceLang: "EN",
    targetLang: "JA",
  }),
  makeWord({
    wordId: "en-hello",
    input: "hello",
    translation: "こんにちは",
    sourceLang: "EN",
    targetLang: "JA",
  }),
];
