// Text search over a saved vocabulary — the Lists search bar. Deliberately SEPARATE
// from filters.ts: those are attribute axes (language, level, confidence, dates) that the
// funnel menu owns, this is one free-text query. Pure + UI-agnostic like the rest of
// services/, so the matching rules are unit-tested rather than eyeballed in the view.
//
// A word is matched on any of three surfaces: its HEADWORD (猫), its MEANING (cat), and —
// the case that makes a Japanese vocabulary searchable at all — its READING (ねこ). You
// cannot type 猫 without an IME and the kanji in front of you; kana you can always type.
//
// Reading matching is gated on the query being KANA-ONLY. That gate is what keeps the
// results honest: an English query like "no" would otherwise hit every word whose reading
// merely contains の, burying the real hits. Kana in, readings searched; anything else,
// headword + meaning only.
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

  return (w) => {
    if (normalize(w.input).includes(q)) return true;
    if (normalize(w.translation).includes(q)) return true;
    // Sound search: only for a kana query, and only against the reading we actually have.
    if (kana && w.inputReading && foldKana(w.inputReading).includes(qFolded)) return true;
    // A kana query should also match a kana/katakana HEADWORD written in the other script
    // (ラーメン ← らーめん), which the raw includes() above misses.
    if (kana && foldKana(normalize(w.input)).includes(qFolded)) return true;
    return false;
  };
}
