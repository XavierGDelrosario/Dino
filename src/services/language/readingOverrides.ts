// =========================================================
// Single-word reading overrides (TEMPORARY, hand-verified, capped).
//
// For a NO-CONTEXT single-word lookup, jmdict_lookup ranks entries by
// (frequency DESC, entry_id, sense). When a kanji has two entries that TIE on
// frequency (they share the surface's corpus frequency), the entry_id tiebreak
// picks arbitrarily — so 前 can headline さき instead of まえ. There is no clean
// automated fix: research (2026-07-03) showed the ambiguous set is ~4,000 words,
// a per-reading-frequency signal is confounded by kuromoji's own priors, and a
// `common`-flag guard is anticorrelated with the right answer. See docs/TODO.md.
//
// What DOES work is a small, hand-verified list of the OBVIOUS high-frequency
// cases. Inclusion criteria (all three, verified by a human — feasible only
// because the list is capped):
//   1. the kanji is a COMMON STANDALONE word (not a bound/compound-only morpheme);
//   2. it has a SINGLE everyday reading when standalone (so no 間 あいだ/ま, no
//      実 み/じつ — genuinely ambiguous words are EXCLUDED, left to the reader);
//   3. jmdict_lookup currently defaults it to the WRONG reading.
// Deliberately EXCLUDED by criterion: 数(すう is compound-only → かず already
// right), 間(both あいだ/ま are words), 日本(にほん already fine), names (宮城→みやぎ),
// register-only picks (後→のち). Context-dependent kanji (日=ひ/にち) never qualify.
//
// This only reorders which sense is PRIMARY for a single-word lookup; it adds no
// data and changes no identity. Applied client-side in lookupWord, so it covers
// both the cache-hit and edge paths in one place. Remove/extend freely — it's a
// bounded stopgap, not the general reading model.
// =========================================================

/** surface (NFC kanji) → its correct everyday standalone reading (hiragana). */
export const SINGLE_WORD_READING_OVERRIDES: Readonly<Record<string, string>> = {
  前: "まえ",   // front / before  (not さき)
  人: "ひと",   // person          (not じん)
  本: "ほん",   // book            (not もと)
  彼: "かれ",   // he              (not あれ)
  娘: "むすめ", // daughter        (not じょう)
  形: "かたち", // shape           (not なり)
  頭: "あたま", // head            (not とう)
  秋: "あき",   // autumn          (not とき/しゅう)
  裏: "うら",   // back / reverse  (not うち/り)
  字: "じ",     // character       (not あざ)
};

/**
 * Reorder senses so the overridden reading is PRIMARY for a single-word lookup.
 * Stable: matching senses keep their order and move to the front; the rest follow.
 * No-op when the surface has no override or no sense carries that reading — so it
 * can never invent a reading, only reprioritize one that jmdict already returned.
 *
 * OUTPUT: the same senses, reordered (or the input array unchanged).
 */
export function applyReadingOverride<T extends { inputReading: string | null }>(
  surface: string,
  senses: T[],
): T[] {
  const pref = SINGLE_WORD_READING_OVERRIDES[surface];
  if (!pref || senses.length < 2) return senses;
  const match = senses.filter((s) => s.inputReading === pref);
  if (match.length === 0 || match.length === senses.length) return senses;
  return [...match, ...senses.filter((s) => s.inputReading !== pref)];
}

// ── Wrong-WORD-from-a-kana-search overrides ─────────────────────────────────
// A separate class from the reading overrides above: searching a KANA surface
// returns a rare homograph first because it shares (or borrows) the surface's
// corpus frequency. Here the candidates share the READING, so a reading override
// can't discriminate — we must reorder by the WRITING (headword). Same capped,
// hand-verified discipline: a common standalone word with an obvious default form.
//   もの   → 物 (thing)  — not 者 (person); both read もの (frequency can't split them)
//   ところ → 所 (place)  — not 野老 (a rare yam that's "usually kana", so it inherits
//                          the common ところ string's frequency and outranks 所)

/** surface (NFC kana) → its correct default WRITING (kanji headword). */
export const SINGLE_WORD_WRITING_OVERRIDES: Readonly<Record<string, string>> = {
  もの: "物",
  ところ: "所",
};

/**
 * Reorder senses so the overridden WRITING is PRIMARY for a single-word lookup.
 * Mirrors applyReadingOverride but matches the headword (`input`) instead of the
 * reading — for cases where the wrong primary shares a reading with the right one.
 * No-op when the surface has no override or no sense carries that writing.
 */
export function applyWritingOverride<T extends { input: string }>(
  surface: string,
  senses: T[],
): T[] {
  const pref = SINGLE_WORD_WRITING_OVERRIDES[surface];
  if (!pref || senses.length < 2) return senses;
  const match = senses.filter((s) => s.input === pref);
  if (match.length === 0 || match.length === senses.length) return senses;
  return [...match, ...senses.filter((s) => s.input !== pref)];
}
