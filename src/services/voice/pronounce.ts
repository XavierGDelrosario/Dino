// =========================================================
// WHAT to speak for a word — the one place our data beats the TTS engine.
//
// Hand a synthesizer 辛い and it guesses a reading; it has no idea which SENSE is
// on screen, so it will happily say からい for the card teaching つらい. We stored
// the sense's own reading when the word was projected from JMdict, so for a kanji
// headword we speak THAT instead and the pronunciation is always sense-correct.
//
// The trap this exists to avoid: `input_reading` is NOT always a pronunciation.
// For JMdict "usually kana" (uk) entries the headword is the KANA and the KANJI
// rides in the reading slot (なる with 成る above it — see CLAUDE.md). Feeding the
// reading blindly would hand the engine kanji to guess at, i.e. exactly the bug
// this is meant to prevent. So the reading is only spoken when the headword is
// the one that needs annotating: kanji surface, kana reading.
// =========================================================

import { isKanaOnly } from "../words/search";
import type { LangCode } from "../language";

/** CJK ideographs (incl. Extension A) — the surfaces a reading disambiguates. */
const HAS_KANJI = /[㐀-䶿一-鿿]/;

/** The word-like shape this reads — a Word, a UserWord and a CardFace all satisfy it. */
export interface SpeakableWord {
  input: string;
  inputReading: string | null;
  sourceLang: LangCode;
}

/**
 * The text to hand the synthesizer for a word's TERM side. The stored reading when
 * it is a genuine pronunciation of a kanji headword, otherwise the headword itself
 * (kana-only words, uk entries whose "reading" is kanji, and every non-Japanese
 * word — an English term is already its own pronunciation).
 */
export function pronounceableText(word: SpeakableWord): string {
  const reading = word.inputReading?.trim();
  if (!reading) return word.input;
  if (!HAS_KANJI.test(word.input)) return word.input; // kana headword (incl. uk)
  if (!isKanaOnly(reading)) return word.input; // the "reading" is kanji, or romaji/pinyin
  return reading;
}
