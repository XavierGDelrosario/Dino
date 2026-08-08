// English lemma for the READER — verb tense + plural. PURE.
//
// The reader looks a token up by `lemma ?? text`, and without a lemma every inflected
// form resolved as itself: cat/cats became separate quiz cards with identical meanings,
// and a homograph surface won outright (sat → 特殊急襲部隊 the assault team, studied →
// わざとらしい). Both valid entries for that spelling, both the wrong word.
//
// WHY THIS CAN'T JUST MIRROR THE EDGE: _lib.ts has a fuller lemmatizer, but it
// OVER-GENERATES candidates and lets the database discard the bogus ones. The reader
// has no verifier — `keyOf` picks exactly one key with no fallback — so the cost is
// asymmetric: a missed lemma keeps today's behaviour, a WRONG lemma silently resolves
// the word to something else. Hence: emit a lemma only where the transformation is
// unambiguous AND the surface is unlikely to be its own word.
//
// DELIBERATELY NOT HANDLED (the edge still covers these for LOOKUP):
//   · regular -ing/-ed — needs a verifier to choose strip-3 vs strip-3+e, and -ing
//     forms are frequently nouns in their own right (building, meeting, feeling).
//   · -es plurals — "buses"→bus and "cases"→case can't be told apart by suffix.
//   · irregulars whose surface is a common word (see EN_IRREGULAR_EXCLUDED), where
//     mapping "left"→leave would cost the direction sense.

import type { LangCode } from "./registry";

/** Irregular past/participle → base, plural → singular. INCLUSION RULE: the surface
 *  must not itself be a common English word (see EN_IRREGULAR_EXCLUDED). */
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

/** Irregulars the edge maps but this module must NOT — each is a common word in its own
 *  right. Exported so the exclusion is testable and obviously intentional. */
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

/** A confident dictionary form for `surface`, or null to look it up as written. The
 *  lemma comes back lowercase, which is what the dictionary is keyed on. */
export function englishLemma(surface: string): string | null {
  const w = surface.normalize("NFC").toLowerCase();
  if (w.length < 3) return null; // too short for any rule to be safe

  const irregular = EN_IRREGULARS[w];
  if (irregular) return irregular;

  // Gates EVERY -s rule, not just the plain one: "series"/"species" end in -ies and
  // would otherwise become "sery"/"specy" before this check was reached.
  if (NOT_A_PLURAL.has(w)) return null;

  // -ies/-ied → -y: unambiguous for plurals and 3rd-person/past alike.
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ied") && w.length > 4) return `${w.slice(0, -3)}y`;

  // Regular plural / 3rd-person -s. Skipped after -ss and -es, whose two readings
  // can't be told apart without a verifier (see the header).
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
