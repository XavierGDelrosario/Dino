// =========================================================
// Closed-class (grammar) words for languages with no POS tagger.
//
// THE BUG THIS FIXES. `isContentPos(null)` returns TRUE — deliberately, so a
// language we can't analyse still shows its words rather than nothing. But English
// gets no POS at all (analyze() routes only JA to kuromoji; everything else returns
// pos/reading/lemma = null), so every English token passed the content-word gate.
// Measured on "The cats were running quickly to the station and it was very cold.":
// all 13 tokens were offered as vocabulary — The→の, to→に, and→そして, was/were→する.
// Japanese never had this problem: kuromoji tags 助詞/助動詞 and the gate drops them.
//
// So this is the English half of what POS already does for Japanese. Matching is by
// SURFACE, which is exactly why the list is small and hand-picked rather than a
// standard stopword corpus: with no POS to disambiguate, every entry is a
// same-spelling gamble, and the cost of a wrong entry is a word the learner can
// never add.
//
// INCLUSION: closed-class AND overwhelmingly grammatical AND not a common noun/verb
// a learner would want to study.
//
// DELIBERATELY EXCLUDED — do not "complete" the list with these:
//   · can · may · will — common NOUNS (a can, the month May, a will). The tokenizer
//     keeps capitalisation, so "May" the month would be demoted by a case-insensitive
//     match. Verified: "In May the May-pole was raised" tokenizes May as a word.
//   · have · has · had · do · does · did — real content verbs ("I have a book").
//   · over · under · up · down · before · after — spatial/temporal vocabulary.
//   · so · yet · when · where · there · here · very — adverbs a learner studies.
// The list therefore under-reaches on purpose: a function word that slips through is
// noise, a content word wrongly demoted is a word you cannot learn.
// =========================================================

import type { LangCode } from "./registry";

/** SYNTHETIC pos for a grammar word — not any tagger's tag, and never in CONTENT_POS.
 *  Like the 人名/組織/外国語 poses, the token stays VISIBLE as plain text; only its
 *  vocabulary-ness is dropped. */
export const FUNCTION_WORD_POS = "function-word";

const ENGLISH_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  // articles + demonstratives
  "a", "an", "the", "this", "that", "these", "those",
  // pronouns
  "i", "you", "he", "she", "it", "we", "they",
  "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their",
  "mine", "yours", "hers", "ours", "theirs",
  "myself", "yourself", "himself", "herself", "itself", "ourselves", "themselves",
  "who", "whom", "whose", "which",
  // copula — the auxiliary BE only; have/do stay content verbs (see header)
  "be", "am", "is", "are", "was", "were", "been", "being",
  // modals without a common noun homograph (can/may/will excluded — see header)
  "should", "would", "could", "might", "must",
  // prepositions
  "of", "to", "in", "on", "at", "by", "for", "with", "from", "into", "onto",
  "as", "than",
  // conjunctions + negation
  "and", "or", "but", "if", "because", "nor", "not",
  // Contractions survive tokenization WHOLE ("don't", "it's", "they're" — verified),
  // so they need their own entries; the tokenizer never splits off the clitic.
  "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't",
  "won't", "can't", "couldn't", "shouldn't", "wouldn't",
  "it's", "i'm", "you're", "he's", "she's", "we're", "they're",
  "that's", "there's",
  "i've", "you've", "we've", "they've",
  "i'll", "you'll", "he'll", "she'll", "we'll", "they'll",
  "i'd", "you'd", "he'd", "she'd", "we'd", "they'd",
]);

/** Per-language closed-class sets. A language absent here keeps `null` — i.e. the
 *  fail-open behaviour every unanalysed language relies on. */
const BY_LANGUAGE: Readonly<Record<string, ReadonlySet<string>>> = {
  EN: ENGLISH_FUNCTION_WORDS,
};

/**
 * The synthetic POS for `text` in `lang`, or null when it isn't a known grammar word
 * (which leaves the token exactly as it was — content by default).
 *
 * Case-insensitive, because a sentence-initial "The" is the same grammar word as
 * "the" — and the reader keys meanings on the raw surface, so both spellings appear.
 * Curly apostrophes are folded to straight so "don’t" matches "don't".
 */
export function functionWordPos(text: string, lang: LangCode): string | null {
  const set = BY_LANGUAGE[lang.toUpperCase()];
  if (!set) return null;
  const key = text.normalize("NFC").toLowerCase().replace(/[‘’]/g, "'");
  return set.has(key) ? FUNCTION_WORD_POS : null;
}
