// =========================================================
// Curated Japanese COMPOUND-MERGE pass (a "compound-aware" post-step for the
// kuromoji analyzer).
//
// kuromoji's IPADIC over-segments some whole words it lacks as a single lexeme —
// e.g. 大規模 → 大 ＋ 規模, 婚活 → 婚 ＋ 活, 主に → 主 ＋ に. The reader then looks up
// the FRAGMENTS against JMdict and loses the meaning (大規模 IS a JMdict word;
// 婚活 resolves only via the full dict / MT — but either way it must be ONE token,
// not two). kuromoji.js has no user-dictionary API (the Java port's UserDictionary
// was dropped), so we can't teach the analyzer these words directly; instead we
// re-merge them AFTER tokenizing.
//
// Deliberately CURATED, not heuristic: a blind "merge adjacent nouns" would wrongly
// fuse genuinely separate words. We only merge an exact, consecutive-surface match
// to a listed compound (longest match first), so the pass can never invent a wrong
// join — at worst it does nothing. The merged token's reading is the concatenation
// of the fragment readings, which is correct for these (大 だい ＋ 規模 きぼ = だいきぼ;
// 主 おも ＋ に = おもに).
//
// Extending: add the surface form here. It only fires when kuromoji actually splits
// the word (if IPADIC already emits it whole, there are no fragments to merge and
// the entry is a harmless no-op), so listing analogues is safe.
// =========================================================

import type { AnalyzedToken } from "./analyze";
import { nfc } from "../../lib/text";

// Seeded from a wordfreq × full-JMdict scan (2026-07-03): tokenize every real
// (wordfreq) Japanese word with kuromoji, keep the ones it OVER-SEGMENTS into a
// noun-run that is nonetheless a real full-JMdict entry (so re-merging is
// validated-correct), down to Zipf ≥ 2.5. That scan found the over-segmentation
// problem is SMALL (~1.3% of words) and its long tail is proper nouns/names —
// which we deliberately do NOT merge as vocabulary. From the clean remainder,
// adult / offensive / slur / hyper-slang hits were removed BY HAND (a web corpus
// surfaces plenty), leaving this bounded general/technical/cultural set. It won't
// bloat: prod's full JMdict already covers the neologisms (婚活 included), so new
// additions are rare. Keep NFC-normalized.
export const JA_COMPOUNDS: readonly string[] = [
  // ～規模 scale compounds — 大/小/中 is a 接頭詞 kuromoji splits off the 規模 noun
  "大規模",
  "小規模",
  "中規模",
  // ～活 "lifestyle-activity" coinages — single kanji IPADIC splits; all in full JMdict
  "婚活",
  "就活",
  "終活",
  "妊活",
  "朝活",
  // adverb — kuromoji peels the adverbializing 助詞 に off the 主 stem
  "主に",
  // general / technical / cultural single-word compounds IPADIC over-segments
  // (real full-JMdict entries; readings resolve from the dictionary in the reader)
  "隕石",   // meteorite
  "閻魔",   // Enma (King of Hell)
  "檸檬",   // lemon
  "仔猫",   // kitten
  "試着",   // trying on (clothes)
  "換装",   // re-equipping / refit
  "閾値",   // threshold
  "攪拌",   // stirring / agitation
  "灌漑",   // irrigation
  "隧道",   // tunnel
  "釉薬",   // (pottery) glaze
  "鍼灸",   // acupuncture and moxibustion
  "頸部",   // neck / cervical region
  "頸椎",   // cervical vertebrae
  "扁桃",   // tonsil / almond
  "塞栓",   // embolus / embolism
  "輸液",   // (medical) infusion
  "培地",   // culture medium
  "咬合",   // (dental) occlusion
  "軟体",   // soft-bodied
  "棲家",   // dwelling / haunt
  "閉園",   // (park/zoo) closing
  "閉所",   // enclosed space (as in 閉所恐怖症)
  // food — kuromoji splits EVERY karaage form (唐揚げ→唐:とう ＋ 揚げ) though all are one
  // full-JMdict entry (1590640, "deep-fried food, esp. chicken"). The wrong kuromoji
  // reading (とうあげ) is corrected by the reader's single-reading dictionary override
  // (→ からあげ). Frequency is NULL (wordfreq can't rank multi-kanji compounds) — fine.
  "唐揚げ",  // karaage (deep-fried chicken)
  "から揚げ",
  "唐揚",
  "からあげ",
].map(nfc);

const COMPOUND_SET = new Set(JA_COMPOUNDS);
const MAX_SPAN = JA_COMPOUNDS.reduce(
  // upper bound on how many tokens a compound could span (its char length: a
  // fragment is ≥ 1 char, so a compound of N chars spans ≤ N tokens).
  (max, c) => Math.max(max, [...c].length),
  0,
);
// First code unit of every compound. The scan only does work at a position whose
// token could START a listed compound — so cost is O(tokens), INDEPENDENT of list
// size (a bigger list just adds O(1) Set entries, not per-token work), and the
// common case (text containing no compound-initial char) is a no-op. This is what
// keeps the "the list might bloat" worry from ever becoming a perf worry.
const FIRST_CHARS = new Set(JA_COMPOUNDS.map((c) => c[0]));

/**
 * Merge consecutive tokens whose concatenated surfaces form a listed compound
 * back into ONE token (longest match first). A pure transform on the analyzed
 * tokens — reading = concatenated fragment readings, lemma = the compound (its
 * own dictionary form), pos = 名詞 (a content POS, so the reader treats it as
 * vocabulary and colors it). Offsets stay pointed back into the source.
 *
 * OUTPUT: a new AnalyzedToken[] (unchanged when nothing merges).
 */
export function mergeJapaneseCompounds(tokens: AnalyzedToken[]): AnalyzedToken[] {
  if (MAX_SPAN < 2) return tokens;
  // Fast path: if NO token starts a listed compound, there's nothing to merge —
  // return the input untouched with zero allocation (the common case for text
  // without any of these compounds). Tokens are already NFC (input is normalized
  // at the boundary; JA_COMPOUNDS is NFC too), so no per-candidate normalize.
  let couldMatch = false;
  for (let i = 0; i < tokens.length; i++) {
    if (FIRST_CHARS.has(tokens[i].text[0])) { couldMatch = true; break; }
  }
  if (!couldMatch) return tokens;
  return mergeSpans(tokens, {
    maxSpan: MAX_SPAN,
    isCompound: (surface) => COMPOUND_SET.has(surface),
    canStart: (t) => FIRST_CHARS.has(t.text[0]),
  });
}

// ---------------------------------------------------------------------------
// Dictionary-validated merge: the general fix the curated list above can't be.
//
// The curated list only covers compounds someone thought to add, and it was
// seeded by a scan over WORDFREQ words — which structurally cannot rank
// multi-kanji compounds (its tokenizer splits them), so this exact class of word
// was invisible to the scan that built it. Hence the recurring reports (柔軟剤,
// 電子レンジ, and every 医薬品-packaging noun): both ARE full-JMdict entries that
// kuromoji splits, neither could ever have been found by that scan.
//
// So instead of guessing which compounds exist, ASK the dictionary. We propose
// candidate merges from adjacent NOUN runs and merge only the ones the dictionary
// confirms are real entries. The caller owns the lookup (it's I/O; this module
// stays pure) — see `dictionaryCompoundCandidates` + `mergeConfirmedCompounds`.
//
// TRADE-OFF, accepted deliberately: two nouns that merely CAN form a word will be
// merged even when the writer meant them separately (大学 ＋ 生活 → 大学生活, itself
// a JMdict entry). We take that because the failure is mild and symmetric — the
// reader shows one real word's real meaning either way — whereas the bug it fixes
// (a word the dictionary HAS, shown as meaningless fragments) is a dead end for
// the learner. Capping the span at 3 keeps a wrong join short.
// ---------------------------------------------------------------------------

/** Longest compound, in TOKENS, we will propose to the dictionary. */
const PROBE_MAX_SPAN = 3;

/**
 * Upper bound on candidates proposed per analysis — a backstop against
 * pathological input, NOT a working limit. Hitting it silently stops merging
 * compounds in the tail of the text, so it must sit above anything a legal paste
 * can produce.
 *
 * Sized from a measurement, not a guess: the worst real sample we have (the
 * medicine-packaging text from quality report #3 — dense technical nouns, far
 * above normal prose) yields 54 candidates from 712 chars, i.e. ~0.08 per char.
 * The paragraph translate is capped upstream at 2000 chars
 * (DEFAULT_PARAGRAPH_CHAR_LIMIT / user_limits.paragraph_char_limit), so the
 * realistic ceiling is ~150. 256 keeps ~1.7x headroom over that.
 *
 * If the paragraph char limit is ever raised, re-derive this — otherwise long
 * pastes start losing compound merges with no error to notice.
 */
const MAX_CANDIDATES = 256;

/** Can this token take part in a proposed compound? Nouns only, and never a
 *  number+counter composite (三本 is already one merged token, not a fragment). */
function isMergeableNoun(t: AnalyzedToken): boolean {
  return t.pos === "名詞" && !t.composite;
}

/**
 * Surfaces to ask the dictionary about: every 2..PROBE_MAX_SPAN run of ADJACENT
 * noun tokens. Adjacency is checked on OFFSETS (`end === start`), so tokens
 * separated by whitespace/punctuation in the source are never joined.
 *
 * OUTPUT: deduped surfaces, longest-first within each start position. Pure.
 */
export function dictionaryCompoundCandidates(tokens: AnalyzedToken[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length && out.length < MAX_CANDIDATES; i++) {
    if (!isMergeableNoun(tokens[i])) continue;
    let surface = tokens[i].text;
    const maxEnd = Math.min(tokens.length, i + PROBE_MAX_SPAN);
    for (let end = i + 1; end < maxEnd; end++) {
      // Stop extending at the first non-noun or non-adjacent token: a compound
      // cannot span a gap, and everything past it is a different run.
      if (!isMergeableNoun(tokens[end]) || tokens[end - 1].end !== tokens[end].start) break;
      surface += tokens[end].text;
      if (!seen.has(surface)) { seen.add(surface); out.push(surface); }
    }
  }
  return out;
}

/**
 * Merge the candidate spans the dictionary CONFIRMED (`confirmed` holds the
 * surfaces that resolved to real senses). Longest match wins, left to right.
 *
 * OUTPUT: a new AnalyzedToken[] (unchanged when nothing merges). Pure.
 */
export function mergeConfirmedCompounds(
  tokens: AnalyzedToken[],
  confirmed: ReadonlySet<string>,
): AnalyzedToken[] {
  if (confirmed.size === 0) return tokens;
  return mergeSpans(tokens, {
    maxSpan: PROBE_MAX_SPAN,
    isCompound: (surface) => confirmed.has(surface),
    canStart: isMergeableNoun,
    eligible: isMergeableNoun,
  });
}

/**
 * Shared span-merge: fold consecutive tokens whose concatenated surfaces satisfy
 * `isCompound` into ONE token (longest match first, left to right). Both the
 * curated and the dictionary-validated passes are this same fold under different
 * membership tests — the merged-token construction below is the part that must
 * not drift between them.
 */
function mergeSpans(
  tokens: AnalyzedToken[],
  opts: {
    maxSpan: number;
    isCompound: (surface: string) => boolean;
    canStart: (t: AnalyzedToken) => boolean;
    /** Extra per-token gate applied to the REST of a span (default: any token). */
    eligible?: (t: AnalyzedToken) => boolean;
  },
): AnalyzedToken[] {
  if (tokens.length < 2) return tokens;
  const eligible = opts.eligible ?? (() => true);
  const out: AnalyzedToken[] = [];
  let i = 0;
  while (i < tokens.length) {
    let bestEnd = -1; // exclusive end of the LONGEST matching compound starting at i
    if (opts.canStart(tokens[i])) {
      const maxEnd = Math.min(tokens.length, i + opts.maxSpan);
      // Extend the surface one token at a time (no slice/map/join), recording the
      // longest span that IS a compound — longest-match wins.
      let surface = tokens[i].text;
      for (let end = i + 1; end < maxEnd; end++) {
        if (!eligible(tokens[end])) break;
        surface += tokens[end].text;
        if (opts.isCompound(surface)) bestEnd = end + 1;
      }
    }
    if (bestEnd >= i + 2) {
      const span = tokens.slice(i, bestEnd);
      out.push({
        text: span.map((t) => t.text).join(""),
        start: span[0].start,
        end: span[span.length - 1].end,
        // Fragment readings are already hiragana; concatenation is the compound
        // reading — but ONLY when every fragment had one (だい+きぼ=だいきぼ). A
        // missing fragment reading (common for the rarer compounds kuromoji
        // splits, e.g. 隕 in 隕石) would make a WRONG partial, so fall back to null
        // and let the dictionary reading fill it in (the reader overrides an
        // unambiguous dictionary reading onto the token anyway).
        reading: span.every((t) => t.reading) ? span.map((t) => t.reading).join("") : null,
        lemma: span.map((t) => t.text).join(""), // the compound IS its own dictionary form
        pos: "名詞", // a content POS → rendered as lookup-able vocabulary
      });
      i = bestEnd;
    } else {
      out.push(tokens[i]);
      i += 1;
    }
  }
  return out;
}
