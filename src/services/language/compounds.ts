// Curated Japanese COMPOUND-MERGE pass — a post-step for the kuromoji analyzer.
//
// IPADIC over-segments whole words it lacks as a single lexeme (大規模 → 大 ＋ 規模,
// 婚活 → 婚 ＋ 活), and the reader then looks up the FRAGMENTS and loses the meaning.
// kuromoji.js has no user-dictionary API, so instead of teaching the analyzer these
// words we re-merge them AFTER tokenizing.
//
// Deliberately CURATED, not heuristic: a blind "merge adjacent nouns" would fuse
// genuinely separate words. Only an exact consecutive-surface match to a listed
// compound merges (longest match first), so the pass can never invent a wrong join —
// at worst it does nothing.
//
// Extending: add the surface form here. It fires only when kuromoji actually splits the
// word, so listing analogues is a harmless no-op. Keep NFC-normalized.

import type { AnalyzedToken } from "./analyze";
import { nfc } from "../../lib/text";

// Seeded from a wordfreq × full-JMdict scan: every real Japanese word kuromoji
// OVER-SEGMENTS into a noun-run that is nonetheless a real full-JMdict entry (so
// re-merging is validated-correct), down to Zipf ≥ 2.5. Over-segmentation turned out
// to be SMALL (~1.3% of words) with a long tail of proper nouns, which we deliberately
// do NOT merge as vocabulary; adult/offensive hits were then removed by hand.
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
  // food — kuromoji splits EVERY karaage form (唐揚げ → 唐:とう ＋ 揚げ) though all are
  // one full-JMdict entry. The wrong reading (とうあげ) is corrected by the reader's
  // single-reading dictionary override.
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
// First code unit of every compound, so work only happens at a position that could
// START one. Cost is O(tokens), INDEPENDENT of list size — a bigger list adds O(1) Set
// entries, not per-token work — so the list can grow without becoming a perf worry.
const FIRST_CHARS = new Set(JA_COMPOUNDS.map((c) => c[0]));

/**
 * Merge consecutive tokens whose concatenated surfaces form a listed compound back into
 * ONE token (longest match first). Pure; offsets stay pointed into the source.
 */
export function mergeJapaneseCompounds(tokens: AnalyzedToken[]): AnalyzedToken[] {
  if (MAX_SPAN < 2) return tokens;
  // Fast path: no token starts a listed compound → return untouched, zero allocation.
  // Tokens and JA_COMPOUNDS are both already NFC, so no per-candidate normalize.
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
// That list was seeded by a scan over WORDFREQ words, whose tokenizer structurally
// cannot rank multi-kanji compounds — so exactly this class of word was invisible to
// the scan that built it (hence the recurring 柔軟剤 / 電子レンジ reports).
//
// So instead of guessing which compounds exist, ASK the dictionary: propose candidates
// from adjacent NOUN runs and merge only what it confirms. The caller owns the lookup
// (it's I/O; this module stays pure).
//
// TRADE-OFF, accepted: two nouns that merely CAN form a word are merged even when the
// writer meant them separately (大学 ＋ 生活 → 大学生活). Mild and symmetric — the reader
// shows one real word's real meaning either way — whereas the bug it fixes (a word the
// dictionary HAS, shown as meaningless fragments) is a dead end. A span cap of 3 keeps
// a wrong join short.
// ---------------------------------------------------------------------------

/** Longest compound, in TOKENS, we will propose to the dictionary. */
const PROBE_MAX_SPAN = 3;

/**
 * Backstop against pathological input, NOT a working limit — hitting it silently stops
 * merging compounds in the tail of the text, so it must sit above anything a legal
 * paste can produce. Sized from the worst real sample (dense technical nouns, ~0.08
 * candidates per char) against the 2000-char paragraph cap: a ~150 ceiling, so 256
 * keeps ~1.7x headroom. RE-DERIVE THIS if the paragraph char limit is ever raised.
 */
const MAX_CANDIDATES = 256;

/** Can this token take part in a proposed compound? Nouns only, and never a
 *  number+counter composite (三本 is already one merged token, not a fragment). */
function isMergeableNoun(t: AnalyzedToken): boolean {
  return t.pos === "名詞" && !t.composite;
}

/**
 * Surfaces to ask the dictionary about: every 2..PROBE_MAX_SPAN run of ADJACENT noun
 * tokens. Adjacency is checked on OFFSETS, so tokens separated by whitespace or
 * punctuation are never joined. Deduped, longest-first per start position. Pure.
 */
export function dictionaryCompoundCandidates(tokens: AnalyzedToken[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length && out.length < MAX_CANDIDATES; i++) {
    if (!isMergeableNoun(tokens[i])) continue;
    let surface = tokens[i].text;
    const maxEnd = Math.min(tokens.length, i + PROBE_MAX_SPAN);
    for (let end = i + 1; end < maxEnd; end++) {
      // A compound can't span a gap, and past it is a different run.
      if (!isMergeableNoun(tokens[end]) || tokens[end - 1].end !== tokens[end].start) break;
      surface += tokens[end].text;
      if (!seen.has(surface)) { seen.add(surface); out.push(surface); }
    }
  }
  return out;
}

/** Merge the spans the dictionary CONFIRMED resolved to real senses. Longest match
 *  wins, left to right. Pure. */
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
 * `isCompound` into ONE token (longest match first). Both passes are this same fold
 * under different membership tests — the merged-token construction is what must not
 * drift between them.
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
      // Extend one token at a time (no slice/map/join), keeping the longest match.
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
        // Fragment readings are hiragana, so concatenation is the compound reading —
        // but ONLY when every fragment had one. A missing one (common for the rarer
        // compounds, e.g. 隕 in 隕石) would make a WRONG partial, so fall back to null
        // and let the reader's dictionary-reading override fill it in.
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
