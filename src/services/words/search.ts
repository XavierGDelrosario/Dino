// Text search over a saved vocabulary — the Lists search bar. Deliberately SEPARATE
// from filters.ts: those are attribute axes (language, level, confidence, dates) that the
// funnel menu owns, this is one free-text query. Pure + UI-agnostic like the rest of
// services/, so the matching rules are unit-tested rather than eyeballed in the view.
//
// A word is matched on any of three surfaces: its HEADWORD (猫), its MEANING (cat), and —
// the case that makes a Japanese vocabulary searchable at all — its READING (ねこ). You
// cannot type 猫 without an IME and the kanji in front of you; kana you can always type.
//
// Reading matching is gated on the query being KANA-ONLY — or clean ROMAJI, which is the
// same search by sound typed on a keyboard that has no kana: "neko" finds 猫 exactly as
// ねこ does. That gate is what keeps the results honest: an English query like "no" would
// otherwise hit every word whose reading merely contains の, burying the real hits.
// Sound in, readings searched; anything else, headword + meaning only.
import { toHiragana } from "../language";
import type { LangCode } from "../language";

/** The word-like shape search reads (a UserWord satisfies it). */
export interface SearchTarget {
  input: string;
  /** The resolved meaning (custom override, else the dictionary's). */
  translation: string;
  /** Reading of the input side, e.g. ねこ for 猫 — null for a word without one. */
  inputReading: string | null;
  sourceLang: LangCode;
}

/** Katakana → hiragana, so ネコ and ねこ are the same query (readings are stored in
 *  hiragana; a learner may type either kana). Leaves everything else untouched. */
function foldKana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** Is the query written ONLY in kana (either script, plus the ー長音 mark)? That is the
 *  signal that the user is searching by SOUND, so readings come into play. */
export function isKanaOnly(q: string): boolean {
  return q.length > 0 && /^[ぁ-ゖゝゞァ-ヶーヽヾ]+$/.test(q);
}

/** Normalize a query the same way the app normalizes everything it stores (NFC), and
 *  case-fold so an English search is case-insensitive. */
function normalize(q: string): string {
  return q.trim().normalize("NFC").toLowerCase();
}

/**
 * A predicate for one query, resolved ONCE (the kana test and normalization are per-query,
 * not per-word — the list re-filters on every keystroke over the whole vocabulary).
 *
 * An empty/blank query matches EVERYTHING, so the caller can apply this unconditionally.
 */
export function makeSearchMatcher(query: string): (word: SearchTarget) => boolean {
  const q = normalize(query);
  if (!q) return () => true;

  const kana = isKanaOnly(q);
  const qFolded = foldKana(q);
  // The kana a ROMAJI query stands for, or null.
  //
  // Gated on the RESULT being at least two kana, not on the input length — that is the
  // axis that decides noise. English function words are valid romaji ("no" → の, "to" →
  // と, "wa" → わ, "ka" → か), and one kana matches a huge share of a Japanese
  // vocabulary: the spec here pins "no" not hitting 飲む, which is precisely the case
  // the reading gate exists to prevent. Two kana up ("neko" → ねこ, "inu" → いぬ) the
  // query is specific enough to mean what it looks like.
  //
  // A kana query is left alone (it is already a sound search), and toHiragana is
  // all-or-nothing, so ordinary English ("cat", "hello") yields null and never gets here.
  const romajiKana = !kana ? toHiragana(q) : null;
  const romaji = romajiKana && romajiKana.length >= 2 ? romajiKana : null;

  return (w) => {
    if (normalize(w.input).includes(q)) return true;
    if (normalize(w.translation).includes(q)) return true;
    // Sound search: only for a kana query, and only against the reading we actually have.
    if (kana && w.inputReading && foldKana(w.inputReading).includes(qFolded)) return true;
    // A kana query should also match a kana/katakana HEADWORD written in the other script
    // (ラーメン ← らーめん), which the raw includes() above misses.
    if (kana && foldKana(normalize(w.input)).includes(qFolded)) return true;
    // Romaji: the same two surfaces as a kana query — reading, then a kana headword.
    // Deliberately NOT the meaning: "same" is valid romaji (さめ) and matching it against
    // English meanings too would pull in every word defined with the word "same".
    if (romaji && w.inputReading && foldKana(w.inputReading).includes(romaji)) return true;
    if (romaji && foldKana(normalize(w.input)).includes(romaji)) return true;
    return false;
  };
}
