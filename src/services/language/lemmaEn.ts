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
// REGULAR -ing / -ed / -es ARE HANDLED ONLY WITH A TAG (2026-10-06). The two objections
// that kept them out — no verifier to choose strip-3 vs strip-3+e, and -ing forms that
// are nouns in their own right (building, meeting) — are both answered now: the POS
// tagger (posEn.ts) says whether the token is a VERB form or a NOUN, and
// `baseFormsEn.generated.ts` (WordNet verbs + frequent nouns) says which candidate stem
// is a real word. A candidate is accepted only when BOTH agree; with no tag (the
// segment-only path, callers without the tagger) these rules do not run at all, and the
// edge still lemmatizes for LOOKUP as before.
//
// DELIBERATELY NOT HANDLED:
//   · -ed / -ing under an ADJ tag (tired, exciting) — the dictionary has the adjective.
//   · irregulars whose surface is a common word (see EN_IRREGULAR_EXCLUDED), where
//     mapping "left"→leave would cost the direction sense.
//   · n't contractions — "don't"→do is safe but "won't"→wo and "shan't"→sha are not,
//     and the common ones are already closed-class words the reader never looks up.

import type { LangCode } from "./registry";
import { EN_IRREGULARS_WORDNET } from "./irregularsEn.generated";

import { own } from "../../lib/own";

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
export function englishLemma(surface: string, opts: { tag?: string | null } = {}): string | null {
  const tag = opts.tag ?? null;
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

  const irregular = own(EN_IRREGULARS, w);
  if (irregular) return irregular;

  // The WordNet long tail (aardwolves→aardwolf, abetted→abet). Filtered at BUILD time to
  // entries that cannot be wrong without a verifier — single token, exactly one base, the
  // surface is not itself a WordNet lemma, and it is not also somebody's regular -s form
  // (lives is the plural of life AND the verb live+s, so it is held back; wolves is not,
  // there being no verb `wolve`). Those are the mechanical form of this file's own
  // inclusion rule. It also settles the doubled-consonant -ing/-ed forms the header
  // defers, because WordNet states the base instead of us guessing at the stem.
  if (!EXCLUDED.has(w)) {
    const listed = own(EN_IRREGULARS_WORDNET, w);
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

  return verifiedRegular(w, tag);
}

// ── The verifier: WordNet base forms, loaded LAZILY ──────────────────────────
// 323 KB of verbs + nouns (baseFormsEn.generated.ts) is only ever consulted under a
// tag, and the tag comes from the POS model, which itself loads lazily — so the tables
// ride the same deferred path (analyze.ts awaits loadEnglishBaseForms before tagging
// a paragraph) instead of sitting in the entry bundle for every learner, Japanese-only
// ones included. Until they have loaded the tag-gated rules simply return null, which
// is the no-tag behaviour.
interface BaseForms {
  verbs: Readonly<Record<string, number>>;
  nouns: ReadonlySet<string>;
}
let tables: BaseForms | null = null;
let loading: Promise<void> | null = null;

/** Load the verifier tables once; safe to call repeatedly. */
export function loadEnglishBaseForms(): Promise<void> {
  if (tables) return Promise.resolve();
  return (loading ??= import("./baseFormsEn.generated").then((m) => {
    tables = { verbs: m.EN_VERB_FREQ, nouns: new Set(m.EN_NOUNS) };
  }));
}

/** Tests only. */
export function __resetEnglishBaseForms(): void {
  tables = null;
  loading = null;
}

const isVerb = (c: string): boolean => !!tables && Object.prototype.hasOwnProperty.call(tables.verbs, c);
const isNoun = (c: string): boolean => !!tables && tables.nouns.has(c);
const verbFreq = (c: string): number => tables?.verbs[c] ?? 0;

/** consonant-vowel-consonant ending (hop, make→mak, tap): such a stem DOUBLES its last
 *  letter before -ing/-ed, so an undoubled form must come from the silent-e base
 *  (hoping → hope, not hop). w/x/y never double. */
const CVC = /[^aeiou][aeiou][b-df-hj-np-tvz]$/;
/** A doubled final consonant (runn, stopp) — the stem may be the undoubled word. */
const DOUBLED = /([b-df-hj-np-tvz])\1$/;
/** A bare stem takes -es only after these (watch→watches, go→goes, bus→buses);
 *  anywhere else "Xes" can only be Xe+s (hope→hopes, use→uses, raise→raises). */
const TAKES_ES = /(s|x|z|ch|sh|o)$/;

/**
 * Candidate stems for an -ing or -ed form, best first, and whether orthography made
 * that order DECISIVE. The CVC rule is decisive (hoping can only be hope). Otherwise
 * the bare stem and the +e stem are both possible and nothing in the spelling
 * separates them (routing: rout | route) — the caller settles that by frequency.
 */
function stemCandidates(stem: string): { cands: string[]; decisive: boolean } {
  const decisive = CVC.test(stem);
  const cands = decisive ? [stem + "e", stem] : [stem, stem + "e"];
  if (DOUBLED.test(stem)) cands.push(stem.slice(0, -1));
  return { cands, decisive };
}

function pickVerb(cands: string[], decisive: boolean): string | null {
  const hits = cands.filter(isVerb);
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  const [a, b] = hits;
  // A doubled stem and its undoubled twin are settled by frequency (put ≫ putt).
  if (b === a.slice(0, -1) && DOUBLED.test(a)) return verbFreq(b) >= verbFreq(a) ? b : a;
  // Two real verbs the spelling cannot separate (rout | route, bath | bathe): the
  // commoner one is the one meant far more often than not.
  if (!decisive) return verbFreq(b) > verbFreq(a) ? b : a;
  return a;
}

/**
 * The tag-gated regular inflections. Only ever returns a word the verifier knows, under
 * the part of speech the tagger saw — see the header. A surface that is ITSELF a base
 * form under that tag (feed, need, bring; species) is returned as null: it is already
 * the dictionary word, and stripping it would invent another (feed → fee).
 */
function verifiedRegular(w: string, tag: string | null): string | null {
  if (!tables) return null;
  if (tag === "VERB") {
    if (isVerb(w)) return null;
    if (w.endsWith("ying") && w.length > 4) {
      // dying → die, lying → lie; else flying → fly. Never dy+e: "dying" is not "dye".
      const ie = w.slice(0, -4) + "ie";
      if (isVerb(ie)) return ie;
      const y = w.slice(0, -3);
      return isVerb(y) ? y : null;
    }
    if (w.endsWith("ing") && w.length > 4) {
      const { cands, decisive } = stemCandidates(w.slice(0, -3));
      return pickVerb(cands, decisive);
    }
    if (w.endsWith("ed") && w.length > 3) {
      const { cands, decisive } = stemCandidates(w.slice(0, -2));
      return pickVerb(cands, decisive);
    }
    if (w.endsWith("es") && w.length > 3) {
      const bare = w.slice(0, -2);
      const full = w.slice(0, -1);
      return pickVerb(TAKES_ES.test(bare) ? [bare, full] : [full], true);
    }
    return null;
  }
  if (tag === "NOUN") {
    if (isNoun(w)) return null;
    // f/v plurals first: leaves → leaf, knives → knife, lives → life. These are held
    // out of the irregulars map (lives is also live+s), and the -es rule below would
    // read leaves as leave+s.
    if (w.endsWith("ves") && w.length > 4) {
      const stem = w.slice(0, -3);
      if (isNoun(stem + "fe")) return stem + "fe";
      if (isNoun(stem + "f")) return stem + "f";
    }
    if (w.endsWith("es") && w.length > 3) {
      const bare = w.slice(0, -2); // bus-es
      const full = w.slice(0, -1); // case-s
      for (const c of TAKES_ES.test(bare) ? [bare, full] : [full]) if (isNoun(c)) return c;
    }
    return null;
  }
  return null;
}

/** The lemma of a possessive's stem: whatever the ordinary rules make of it, else the
 *  stem itself — the apostrophe is gone either way, which is the point. */
function lemmaOfStem(stem: string): string {
  // No tag here on purpose: a possessive's stem is very often a NAME (james's), and
  // the tag-gated -es rule would happily read james as jam+es.
  return englishLemma(stem) ?? stem;
}

/** Per-language reader lemma. Languages with their own analyser (JA → kuromoji) and
 *  languages with no rules both return null here. */
export function readerLemma(surface: string, opts: { lang: LangCode; tag?: string | null }): string | null {
  return opts.lang.toUpperCase() === "EN" ? englishLemma(surface, { tag: opts.tag }) : null;
}
