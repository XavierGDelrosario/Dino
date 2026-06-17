// =========================================================
// Reading annotations (furigana / pinyin / …) for an entry.
//
// A dictionary sense or a user_word carries a reading per side
// (`inputReading` / `translationReading`); each is set only when that side
// needs one — kana over Japanese kanji, pinyin over Chinese hanzi, NULL over a
// phonetic script like English or Hangul. `furiganaFor` resolves which sides
// actually have a reading, so the UI doesn't poke at the raw fields and the
// "input, translation, both, or neither" cases have one place to test.
//
// Script-agnostic: the column holds whatever the source provides; nothing here
// assumes Latin.
// =========================================================

/** A reading annotation over one side of an entry. */
export interface Furigana {
  /** The side it annotates. */
  side: "input" | "translation";
  /** The term being read. */
  term: string;
  /** Its reading (kana, pinyin, …). */
  reading: string;
}

/** Minimal shape `furiganaFor` needs — satisfied by both `Word` and `UserWord`. */
export interface Readable {
  input: string;
  translation: string;
  inputReading: string | null;
  translationReading: string | null;
}

/**
 * The reading annotations an entry carries — one per side that has a reading.
 *
 * OUTPUT: Furigana[] in input-then-translation order; [] when neither side has
 * one. JA→EN yields the input only, EN→JA the translation only, JA→ZH both.
 */
export function furiganaFor(entry: Readable): Furigana[] {
  const out: Furigana[] = [];
  if (entry.inputReading) {
    out.push({ side: "input", term: entry.input, reading: entry.inputReading });
  }
  if (entry.translationReading) {
    out.push({ side: "translation", term: entry.translation, reading: entry.translationReading });
  }
  return out;
}
