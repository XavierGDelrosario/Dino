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
//     EXCEPT where Princeton WordNet names the base outright (abetted→abet,
//     abhorring→abhor): those come from `irregularsEn.generated.ts`, where there is
//     nothing to guess at, so the objection above does not apply to them.
//   · -es plurals — "buses"→bus and "cases"→case can't be told apart by suffix.
//   · irregulars whose surface is a common word (see EN_IRREGULAR_EXCLUDED), where
//     mapping "left"→leave would cost the direction sense.
//   · n't contractions — "don't"→do is safe but "won't"→wo and "shan't"→sha are not,
//     and the common ones are already closed-class words the reader never looks up.

import type { LangCode } from "./registry";
import { EN_IRREGULARS_WORDNET } from "./irregularsEn.generated";

/** Irregular past/participle → base, plural → singular. INCLUSION RULE: the surface
 *  must not itself be a common English word (see EN_IRREGULAR_EXCLUDED).
 *
 *  Kept BY HAND even though the generated WordNet map below covers the long tail:
 *  WordNet lists exceptions to its own morphology rules, so `does`, `women` and `people`
 *  are missing from it and `is` is listed against itself. These are the forms a learner
 *  actually meets, so they stay explicit and stay first. */
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

/** The exclusion applies to the GENERATED map too, and there it is load-bearing rather
 *  than documentary: the generator drops a surface that is itself a WordNet lemma, which
 *  independently reproduces 21 of the 23 above — but not `met` or `meant`, which WordNet
 *  does not list as lemmas. Without this set those two would start resolving. */
const EXCLUDED = new Set(EN_IRREGULAR_EXCLUDED);

/** Words ending in -s that are not plurals — stripping would invent a word. */
const NOT_A_PLURAL = new Set([
  "news", "series", "species", "physics", "mathematics", "economics", "politics",
  "lens", "bus", "gas", "plus", "thus", "always", "perhaps", "unless", "yes",
  "this", "his", "its", "us", "was", "is", "as", "has",
  "clothes", "scissors", "glasses", "means", "focus", "campus", "virus", "status",
]);

/** Possessive / contracted `'s` (europe's, children's, what's) and the bare trailing
 *  apostrophe of a plural possessive (workers'). Curly apostrophes fold to straight,
 *  as in functionWords. */
const POSSESSIVE_S = /['’]s$/;
const TRAILING_APOSTROPHE = /['’]$/;

/** A confident dictionary form for `surface`, or null to look it up as written. The
 *  lemma comes back lowercase, which is what the dictionary is keyed on. */
export function englishLemma(surface: string): string | null {
  const w = surface.normalize("NFC").toLowerCase();
  if (w.length < 3) return null; // too short for any rule to be safe

  // POSSESSIVES FIRST — before any -s rule, which would otherwise read the `s` of
  // `europe's` as a plural and leave the apostrophe behind (`europe'`). That form is
  // a guaranteed dictionary miss AND still contains a letter, so `shouldSkipMt` lets
  // it through to a PAID translation, cached as a junk row the reader offers as a
  // word. Measured at 2.6% of types in a 250-article en.wikinews sample.
  //
  // The stripped form is re-lemmatized (children's → children → child), and stands on
  // its own when no further rule fires (boss's → boss) — returning null there would
  // put the apostrophe back by looking the token up as written.
  if (POSSESSIVE_S.test(w)) return lemmaOfStem(w.slice(0, -2));
  // A plural possessive keeps its `s`, so the ordinary plural rule still applies
  // (workers' → workers → worker). A singular name ending in -s can over-strip
  // (harris' → harri; the -es/-ss/-us guards already spare james'/jesus'/wales'), which
  // is accepted: a name misses the dictionary either way, so the two forms fail
  // identically while the plural case genuinely resolves.
  if (TRAILING_APOSTROPHE.test(w)) return lemmaOfStem(w.slice(0, -1));

  const irregular = EN_IRREGULARS[w];
  if (irregular) return irregular;

  // The WordNet long tail (aardwolves→aardwolf, abetted→abet). Filtered at BUILD time to
  // entries that cannot be wrong without a verifier — single token, exactly one base, the
  // surface is not itself a WordNet lemma, and it is not also somebody's regular -s form
  // (lives is the plural of life AND the verb live+s, so it is held back; wolves is not,
  // there being no verb `wolve`). Those are the mechanical form of this file's own
  // inclusion rule. It also settles the doubled-consonant -ing/-ed forms the header
  // defers, because WordNet states the base instead of us guessing at the stem.
  if (!EXCLUDED.has(w)) {
    const listed = EN_IRREGULARS_WORDNET[w];
    if (listed) return listed;
  }

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

/** The lemma of a possessive's stem: whatever the ordinary rules make of it, else the
 *  stem itself — the apostrophe is gone either way, which is the point. */
function lemmaOfStem(stem: string): string {
  return englishLemma(stem) ?? stem;
}

/** Per-language reader lemma. Languages with their own analyser (JA → kuromoji) and
 *  languages with no rules both return null here. */
export function readerLemma(surface: string, lang: LangCode): string | null {
  return lang.toUpperCase() === "EN" ? englishLemma(surface) : null;
}
