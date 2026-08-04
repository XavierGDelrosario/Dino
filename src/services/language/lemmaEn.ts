// =========================================================
// English lemma for the READER — verb tense + plural (PURE, tested).
//
// WHAT WAS BROKEN. The reader looks a token up by `lemma ?? text` (lookup.ts
// `keyOf`), and English tokens had no lemma, so every inflected form was looked up
// as itself. Measured on "The cat sat while the cats ran. He runs and they were
// running. She studies what he studied.":
//   · DUPLICATION — cat/cats and ran/runs/running each resolved to a DIFFERENT
//     words row, so one word became several quiz cards with identical meanings.
//   · WRONG WORD — a surface that is a homograph of something else wins outright:
//     sat → 特殊急襲部隊 (SAT, the Special Assault Team), studied → わざとらしい
//     (the adjective "studied" = affected). Both are valid entries for that
//     spelling, and both are the wrong word for the sentence.
//
// WHY THIS CAN'T JUST MIRROR THE EDGE. supabase/functions/translate/_lib.ts has a
// fuller lemmatizer, but it works by OVER-GENERATING candidates and letting the
// database throw the bogus ones away ("buses"→"buse" simply returns no rows). The
// reader has no such verifier: `keyOf` picks exactly one key and there is NO
// fallback to the surface if it resolves to nothing. So the cost is asymmetric in
// the same way the closed-class list is — a missed lemma leaves today's behaviour,
// a WRONG lemma silently resolves the word to something else.
//
// Hence: emit a lemma only where the transformation is unambiguous AND the surface
// is unlikely to be its own word. Everything else returns null and is looked up as
// written, exactly as before.
//
// DELIBERATELY NOT HANDLED (the edge still covers these for LOOKUP; they only stay
// duplicated in the reader):
//   · regular -ing / -ed — "walking"→walk vs "making"→make needs a verifier to pick
//     between strip-3 and strip-3+e, and worse, -ing forms are frequently NOUNS in
//     their own right (building · meeting · painting · feeling). Demoting those to
//     the verb would lose the word the learner actually met.
//   · -es plurals — "buses"→bus and "cases"→case share the -ses ending and cannot be
//     told apart by suffix. The edge tries both; we can't.
//   · irregulars whose surface is a common word — saw · left · found · felt · lost ·
//     won · rose · ground · lay · met · read. Mapping "left"→leave would cost the
//     direction sense. These are listed in EN_IRREGULAR_EXCLUDED so the omission is
//     visible rather than looking like a gap someone should fill.
// =========================================================

import type { LangCode } from "./registry";

/**
 * Irregular past/participle → base, and irregular plural → singular.
 *
 * INCLUSION: the surface must not itself be a common English word. That is the whole
 * safety rule here — see EN_IRREGULAR_EXCLUDED for the ones it rejects.
 */
const EN_IRREGULARS: Readonly<Record<string, string>> = {
  // strong verbs — past / past participle → base
  ran: "run", sat: "sit", went: "go", gone: "go", took: "take", taken: "take",
  came: "come", gave: "give", given: "give", knew: "know", known: "know",
  wrote: "write", written: "write", spoke: "speak", spoken: "speak",
  ate: "eat", eaten: "eat", drove: "drive", driven: "drive",
  broke: "break", broken: "break", chose: "choose", chosen: "choose",
  forgot: "forget", forgotten: "forget", hid: "hide", hidden: "hide",
  flew: "fly", flown: "fly", grew: "grow", grown: "grow",
  threw: "throw", thrown: "throw", began: "begin", begun: "begin",
  drew: "draw", drawn: "draw", wore: "wear", worn: "wear",
  risen: "rise", fallen: "fall", swam: "swim", swum: "swim",
  bought: "buy", brought: "bring", caught: "catch", taught: "teach",
  sought: "seek", became: "become", understood: "understand",
  stood: "stand", sold: "sell",
  // irregular plurals
  men: "man", women: "woman", children: "child", feet: "foot",
  teeth: "tooth", geese: "goose", mice: "mouse", oxen: "ox",
};

/**
 * Irregular forms the edge maps but this module must NOT: each is a common word in
 * its own right, so lemmatizing it would cost the learner that sense. Exported so the
 * exclusion is testable and obviously intentional, not an oversight.
 */
export const EN_IRREGULAR_EXCLUDED: readonly string[] = [
  "saw", "left", "found", "felt", "lost", "won", "rose", "ground", "lay",
  "met", "read", "held", "kept", "led", "sent", "spent", "built", "made",
  "paid", "heard", "meant", "thought", "people",
];

/** Words ending in -s that are not plurals — stripping would invent a word. */
const NOT_A_PLURAL = new Set([
  "news", "series", "species", "physics", "mathematics", "economics", "politics",
  "lens", "bus", "gas", "plus", "thus", "always", "perhaps", "unless", "yes",
  "this", "his", "its", "us", "was", "is", "as", "has",
  "clothes", "scissors", "glasses", "means", "focus", "campus", "virus", "status",
]);

/**
 * A confident dictionary form for `surface`, or null to look it up as written.
 *
 * Case is preserved on the way in and the lemma comes back lowercase, which is what
 * the dictionary is keyed on; the reader re-exposes results under the original
 * surface either way.
 */
export function englishLemma(surface: string): string | null {
  const w = surface.normalize("NFC").toLowerCase();
  if (w.length < 3) return null; // too short for any rule to be safe

  const irregular = EN_IRREGULARS[w];
  if (irregular) return irregular;

  // Gate EVERY -s rule, not just the plain one: "series"/"species" end in -ies and
  // would otherwise become "sery"/"specy" before this check was ever reached.
  if (NOT_A_PLURAL.has(w)) return null;

  // -ies → -y. Unambiguous for both plurals and 3rd-person/past: studies → study,
  // cities → city. (-ied is handled the same way: studied → study.)
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ied") && w.length > 4) return `${w.slice(0, -3)}y`;

  // Regular plural / 3rd-person -s. Skipped after -ss (glass, pass) and -es, whose
  // two readings can't be told apart without a verifier (see the header).
  if (
    w.endsWith("s") &&
    !w.endsWith("ss") &&
    !w.endsWith("es") &&
    !w.endsWith("us") &&
    w.length > 3
  ) {
    return w.slice(0, -1);
  }

  return null;
}

/** Per-language reader lemma. Languages with their own analyser (JA → kuromoji) and
 *  languages with no rules both return null here. */
export function readerLemma(surface: string, lang: LangCode): string | null {
  return lang.toUpperCase() === "EN" ? englishLemma(surface) : null;
}
