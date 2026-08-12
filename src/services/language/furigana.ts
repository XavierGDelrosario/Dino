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

const HAS_KANJI = /[\p{Script=Han}]/u;
const nfc = (s: string) => s.normalize("NFC");

/**
 * How to HEADLINE one sense for the term that was searched.
 *
 * Normally the stored row already answers this: `input` is the headword and
 * `inputReading` annotates it. The exception is a JMdict `uk` entry ("usually
 * written in kana"), which is stored INVERTED on purpose — 概ね headlines as
 * おおむね with the kanji in the annotation slot, so なる shows なる(成る).
 *
 * That inversion reads backwards to anyone who searched the KANJI: 概ね returns
 * おおむね with 概ね above it, which says "the reading of おおむね is 概ね" — a
 * quality report (#17). So when the query IS the annotation, and the annotation
 * is the kanji form, the two swap FOR DISPLAY. Nothing stored changes: the
 * headword invariant, the saved row and its identity are untouched.
 *
 * The kanji test is what keeps this narrow. An ordinary row (猫 / ねこ) searched
 * by its reading also matches the query, but its annotation is kana, so it stays
 * 猫[ねこ] rather than flipping to ねこ[猫].
 *
 * OUTPUT: the term to headline + the reading to sit above it (null for none).
 * PURE.
 */
export function displayHeadword(
  entry: Readable,
  query?: string | null,
): { head: string; reading: string | null } {
  const reading = entry.inputReading;
  if (
    query &&
    reading &&
    nfc(query.trim()) === nfc(reading) &&
    HAS_KANJI.test(reading) &&
    !HAS_KANJI.test(entry.input)
  ) {
    return { head: reading, reading: entry.input };
  }
  return { head: entry.input, reading };
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
