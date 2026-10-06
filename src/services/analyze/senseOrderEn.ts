// =========================================================
// Put the ENGLISH sense the sentence actually used first (PURE, tested).
//
// The Japanese reader disambiguates a homograph by its reading in context
// (senseOrder.ts) — English has no reading, so until now the reader showed an English
// word's senses in dictionary order whatever the sentence said: "spring" was 春 in
// 「the spring broke」 and "light" was 光 in 「a light meal」. Two signals this module
// has that the dictionary order does not:
//
//   1. THE TAGGER'S PART OF SPEECH (posEn.ts, UD tags on every English token). An EN→JA
//      sense row carries the WordNet POS of the synset it came from (20260760), so a
//      token tagged VERB leads with the verb senses and a NOUN with the nouns. This is
//      the strong, cheap half: it never needs the sentence's words.
//   2. DEFINITION OVERLAP (Lesk). Each EN→JA sense carries its synset's English
//      definition (20260764). The sense whose definition shares the most content words
//      with the surrounding sentence wins within the POS group — "the spring broke" vs
//      "a metal elastic device …" is weak, but "water from the spring" vs "a natural
//      flow of ground water" is exactly the hit this was built for.
//
// CONSERVATIVE, like the Japanese rule — it declines rather than guesses:
//   · fewer than two senses                         → nothing to disambiguate
//   · the tag matches every sense, or none          → POS doesn't separate them
//   · no definition shares a word with the sentence → the dictionary knew better
//   · a tie at the top                              → dictionary order stands
// It is a REORDER only: no sense is dropped, relative order is kept within each group,
// and cycling still reaches everything.
//
// Rows cached before 20260760/20260764 carry JMdict POS codes (adj-i, v5r) and no
// definition; the POS map below reads those too, and a missing definition simply
// scores 0. They re-project on their next lookup anyway (projection v16).
// =========================================================

import { isContentPos, type AnalyzedToken } from "../language";
import { englishLemma } from "../language/lemmaEn";
import { functionWordPos } from "../language/functionWords";

/** A UD UPOS tag (NOUN, VERB, …) — what the English tagger puts on a token's `pos`.
 *  kuromoji's tags are Japanese script, so this is also "is this an English token". */
export const isUposTag = (tag: string | null | undefined): tag is string => !!tag && /^[A-Z]+$/.test(tag);

/** UPOS → WordNet POS letter. Tags with no WordNet class (DET, ADP, …) map to nothing. */
const UPOS_TO_WN: Readonly<Record<string, string>> = {
  NOUN: "n",
  PROPN: "n",
  VERB: "v",
  AUX: "v",
  ADJ: "a",
  ADV: "r",
};

/** The WordNet letters a sense row's part_of_speech amounts to. WordNet letters pass
 *  through (`s`, the adjective satellite, counts as `a`); JMdict codes on older rows
 *  are mapped by their leading class. */
export function senseLetters(partOfSpeech: readonly string[] | null | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const p of partOfSpeech ?? []) {
    const code = p.toLowerCase();
    if (code === "n" || code === "v" || code === "r") out.add(code);
    else if (code === "a" || code === "s") out.add("a");
    else if (code.startsWith("adj")) out.add("a");
    else if (code.startsWith("adv")) out.add("r");
    else if (code.startsWith("v")) out.add("v");
    else if (code.startsWith("n") || code === "pn" || code === "num" || code === "ctr") out.add("n");
  }
  return out;
}

/** One sentence/definition word as the overlap compares it: lowercase, letters only,
 *  lemmatized, and NOT a function word or a stub. Null = contributes nothing. */
function contentWord(raw: string): string | null {
  const w = raw.toLowerCase().replace(/[^a-z']/g, "");
  if (w.length < 3) return null;
  if (functionWordPos(w, "EN")) return null;
  return englishLemma(w) ?? w;
}

/** The content words of a definition, as a set. Examples inside quotes count too —
 *  they are the words a sense actually keeps company with. */
export function definitionWords(definition: string | null | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  if (!definition) return out;
  for (const piece of definition.split(/[^A-Za-z']+/)) {
    const w = contentWord(piece);
    if (w) out.add(w);
  }
  return out;
}

/** How many tokens either side of a word count as its context. Wide enough to hold a
 *  long sentence's content words, narrow enough that a paragraph's unrelated sentences
 *  don't vote. */
export const CONTEXT_WINDOW = 12;

/**
 * For every ENGLISH token, the content words around it (its own word excluded) —
 * keyed by token identity so the call sites need no index plumbing. Japanese tokens
 * get no entry (they are disambiguated by reading, not by this).
 */
export function contextWindows(tokens: readonly AnalyzedToken[], window = CONTEXT_WINDOW): Map<AnalyzedToken, ReadonlySet<string>> {
  const out = new Map<AnalyzedToken, ReadonlySet<string>>();
  // Normalize once per token, not once per neighbour.
  const words = tokens.map((t) => {
    if (!isUposTag(t.pos) || !isContentPos(t.pos)) return null;
    const a = contentWord(t.text);
    const b = t.lemma ? contentWord(t.lemma) : null;
    return a || b ? { a, b } : null;
  });
  tokens.forEach((t, i) => {
    if (!isUposTag(t.pos)) return;
    const set = new Set<string>();
    const lo = Math.max(0, i - window);
    const hi = Math.min(tokens.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (j === i) continue;
      const w = words[j];
      if (!w) continue;
      if (w.a) set.add(w.a);
      if (w.b) set.add(w.b);
    }
    out.set(t, set);
  });
  return out;
}

const overlap = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
};

/**
 * `senses` reordered for an English token: the tagger's POS group first, and within
 * it the sense whose definition shares the most content words with `context`. Returns
 * the input array unchanged (same reference) whenever there is nothing useful to do.
 */
export function orderSensesByContextEn<T extends { partOfSpeech: string[] | null; definitionSource: string | null }>(
  senses: T[],
  tag: string | null | undefined,
  context: ReadonlySet<string> | undefined,
): T[] {
  if (senses.length < 2) return senses;

  // 1. POS gate — only when it genuinely separates the senses.
  const want = tag ? UPOS_TO_WN[tag] : undefined;
  let lead: T[] = senses;
  let rest: T[] = [];
  if (want) {
    const match = senses.filter((s) => senseLetters(s.partOfSpeech).has(want));
    if (match.length > 0 && match.length < senses.length) {
      lead = match;
      rest = senses.filter((s) => !match.includes(s));
    }
  }

  // 2. Definition overlap within the leading group — only when a sense beats the one
  //    already in front, and strictly (a tie is not evidence).
  let ordered = lead;
  if (context && context.size > 0 && lead.length > 1) {
    const scores = lead.map((s) => overlap(definitionWords(s.definitionSource), context));
    const max = Math.max(...scores);
    if (max > 0 && scores[0] < max) {
      ordered = lead
        .map((s, i) => ({ s, i, score: scores[i] }))
        .sort((x, y) => y.score - x.score || x.i - y.i)
        .map((x) => x.s);
    }
  }

  if (ordered === lead && rest.length === 0) return senses;
  return [...ordered, ...rest];
}
