// =========================================================
// Coarse PART-OF-SPEECH categorisation.
//
// `words.part_of_speech` carries JMdict's fine-grained POS CODES (n, v5r, adj-i,
// vi, …) — several per sense, and too granular to show a learner ("godan verb
// with 'ru' ending, intransitive"). This collapses that code list to ONE coarse,
// learner-facing CATEGORY (noun / verb / adjective / …) that the UI renders via
// i18n. PURE + read-time, like getProficiency: no I/O, safe during render.
//
// Deliberately a category ENUM (not a free label) so the display string is chosen
// by the i18n layer, not hard-coded here. Returns null when nothing maps (a
// non-JMdict / MT row with no POS, or an unrecognised code).
// =========================================================

/** Coarse, learner-facing word class. */
export type PosCategory =
  | "noun"
  | "pronoun"
  | "verb"
  | "adjective"
  | "adverb"
  | "particle"
  | "conjunction"
  | "interjection"
  | "auxiliary"
  | "counter"
  | "prefix"
  | "suffix"
  | "numeric"
  | "determiner"
  | "expression";

/** Map ONE JMdict POS code to a coarse category, or null if unrecognised. */
function categoryOf(code: string): PosCategory | null {
  // Exact codes first (some collide with the prefix rules below — e.g. "num"
  // starts with "n", "adv"/"aux" would be swallowed by broader tests).
  if (code === "exp") return "expression";
  if (code === "pn") return "pronoun";
  if (code === "num") return "numeric";
  if (code === "ctr") return "counter";
  if (code === "prt") return "particle";
  if (code === "conj") return "conjunction";
  if (code === "int") return "interjection";
  if (code === "pref") return "prefix";
  if (code === "suf") return "suffix";
  if (code === "adj-pn") return "determiner"; // pre-noun adjectival (この, その)
  // Prefix families.
  if (code === "adv" || code === "adv-to") return "adverb";
  if (code.startsWith("adj")) return "adjective"; // adj-i, adj-na, adj-no, …
  if (code.startsWith("aux") || code.startsWith("cop")) return "auxiliary";
  if (code.startsWith("v")) return "verb"; // v1, v5r, vk, vs-i, vi, vt, vz, …
  if (code.startsWith("n")) return "noun"; // n, n-adv, n-suf, n-pr, …
  return null;
}

/**
 * The single coarse word class for a sense, from its JMdict POS codes — the FIRST
 * code that maps to a category (JMdict orders the word-class code ahead of
 * modifiers like transitivity). null when the list is empty/absent or nothing maps.
 *
 * OUTPUT: a PosCategory, or null. PURE — safe to call during render.
 */
export function partOfSpeechCategory(pos: string[] | null | undefined): PosCategory | null {
  if (!pos) return null;
  for (const code of pos) {
    const cat = categoryOf(code);
    if (cat) return cat;
  }
  return null;
}
