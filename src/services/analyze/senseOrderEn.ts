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
//      with the surrounding sentence wins within the POS group — "water from the
//      spring" vs "a natural flow of ground water" is exactly the hit this was built for.
//
// CONSERVATIVE, like the Japanese rule — it declines rather than guesses:
//   · fewer than two senses                         → nothing to disambiguate
//   · the tag matches every sense, or none          → POS doesn't separate them
//   · no definition shares a word with the sentence → the dictionary knew better
//   · the top score is SHARED by two senses         → no evidence between them
//   · ONE shared word, and other senses share one too → too thin to move the primary
//     (a single hit promotes only when it is the only sense scoring at all)
// It is a REORDER only: no sense is dropped, relative order is kept within each group,
// and cycling still reaches everything. The primary is what "Add all" SAVES, so the
// bar for moving it is deliberately high.
//
// WHAT COUNTS AS A WORD on either side: NFC, lowercased, letters only, lemmatized, and
// neither a function word nor WordNet's own boilerplate (something, someone, used,
// act, …), which would otherwise vote for whichever definition happens to use it. A
// sense's definition also drops its HEADWORD — WordNet's examples quote the word being
// defined ("a light meal"), so a word repeated in the sentence would promote whichever
// sense has an example. The same repeat is left out of the context window too.
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

/** WordNet's definitional boilerplate — words that describe HOW a sense is defined,
 *  not WHAT it is, and so appear across unrelated senses. The function-word list
 *  (functionWords.ts) under-reaches on purpose for the reader; this is the gate for
 *  definition text and sentence context alike. */
const DEFINITION_STOPWORDS: ReadonlySet<string> = new Set([
  "something", "someone", "somebody", "anything", "anyone", "everything", "nothing",
  "one", "ones", "other", "another", "same", "such", "various", "certain", "particular",
  "used", "use", "using", "usually", "especially", "often", "sometimes", "generally",
  "act", "action", "state", "quality", "condition", "process", "result", "cause", "make",
  "made", "making", "give", "given", "giving", "take", "taken", "taking", "put", "get",
  "become", "becoming", "having", "have", "has", "had", "being", "been",
  "person", "people", "thing", "things", "kind", "type", "sort", "way", "part", "form",
  "place", "time", "means", "manner", "degree", "amount", "number", "group", "set",
  "large", "small", "very", "more", "most", "less", "much", "many", "also", "there",
  "when", "where", "while", "than", "then", "into", "onto", "upon", "without", "within",
]);

/** One sentence/definition word as the overlap compares it: NFC, lowercase, letters
 *  only, lemmatized, and NOT a function word, boilerplate or a stub. Null = nothing. */
function contentWord(raw: string): string | null {
  const w = raw.normalize("NFC").toLowerCase().replace(/[^\p{L}']/gu, "");
  if (w.length < 3) return null;
  if (functionWordPos(w, "EN") || DEFINITION_STOPWORDS.has(w)) return null;
  const lemma = englishLemma(w) ?? w;
  return DEFINITION_STOPWORDS.has(lemma) ? null : lemma;
}

/** The content words of a definition, as a set. Examples inside quotes count too —
 *  they are the words a sense actually keeps company with. */
export function definitionWords(definition: string | null | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  if (!definition) return out;
  // NFC first: a decomposed accent is a combining mark, not a letter, and would split
  // the word in two before contentWord ever saw it.
  for (const piece of definition.normalize("NFC").split(/[^\p{L}']+/u)) {
    const w = contentWord(piece);
    if (w) out.add(w);
  }
  return out;
}

/** definitionWords for a sense row, minus its own headword, computed once per row (the
 *  same Word object is scored for every occurrence on the page and every render). */
const senseWordsCache = new WeakMap<object, ReadonlySet<string>>();
function senseWords(sense: { definitionSource: string | null; input?: string }): ReadonlySet<string> {
  const hit = senseWordsCache.get(sense);
  if (hit) return hit;
  const words = new Set(definitionWords(sense.definitionSource));
  const head = sense.input ? contentWord(sense.input) : null;
  if (head) words.delete(head);
  senseWordsCache.set(sense, words);
  return words;
}

/** How many tokens either side of a word count as its context. Wide enough to hold a
 *  long sentence's content words, narrow enough that a paragraph's unrelated sentences
 *  don't vote. */
export const CONTEXT_WINDOW = 12;

/**
 * For every ENGLISH token, the content words around it — its own word excluded, in
 * every occurrence — keyed by token identity so the call sites need no index plumbing.
 * Japanese tokens get no entry (they are disambiguated by reading, not by this).
 */
export function contextWindows(tokens: readonly AnalyzedToken[], opts: { window?: number } = {}): Map<AnalyzedToken, ReadonlySet<string>> {
  const window = opts.window ?? CONTEXT_WINDOW;
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
    const own = new Set([words[i]?.a, words[i]?.b].filter((w): w is string => !!w));
    const set = new Set<string>();
    const lo = Math.max(0, i - window);
    const hi = Math.min(tokens.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (j === i) continue;
      const w = words[j];
      if (!w) continue;
      if (w.a && !own.has(w.a)) set.add(w.a);
      if (w.b && !own.has(w.b)) set.add(w.b);
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
export function orderSensesByContextEn<
  T extends { partOfSpeech: string[] | null; definitionSource: string | null; input?: string },
>(opts: { senses: T[]; tag: string | null | undefined; context: ReadonlySet<string> | undefined }): T[] {
  const { senses, tag, context } = opts;
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

  // 2. Definition overlap within the leading group — only when ONE sense beats the one
  //    already in front, and either by two or more shared words or as the only sense
  //    that shares any (see the header).
  let ordered = lead;
  if (context && context.size > 0 && lead.length > 1) {
    const scores = lead.map((s) => overlap(senseWords(s), context));
    const max = Math.max(...scores);
    const atMax = scores.filter((n) => n === max).length;
    const scoring = scores.filter((n) => n > 0).length;
    const decisive = max >= 2 || scoring === 1;
    if (max > 0 && scores[0] < max && atMax === 1 && decisive) {
      // Only the WINNER moves; everything else keeps the dictionary order.
      const winner = lead[scores.indexOf(max)];
      ordered = [winner, ...lead.filter((s) => s !== winner)];
    }
  }

  if (ordered === lead && rest.length === 0) return senses;
  return [...ordered, ...rest];
}
