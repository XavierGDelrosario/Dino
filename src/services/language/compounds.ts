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
].map((s) => s.normalize("NFC"));

const COMPOUND_SET = new Set(JA_COMPOUNDS);
const MAX_SPAN = JA_COMPOUNDS.reduce(
  // upper bound on how many tokens a compound could span (its char length: a
  // fragment is ≥ 1 char, so a compound of N chars spans ≤ N tokens).
  (max, c) => Math.max(max, [...c].length),
  0,
);

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
  if (tokens.length < 2 || MAX_SPAN < 2) return tokens;
  const out: AnalyzedToken[] = [];
  let i = 0;
  while (i < tokens.length) {
    let merged = false;
    // Try the LONGEST span first so a listed super-compound wins over a listed
    // sub-compound (e.g. prefer 大規模 over a hypothetical 規模-only entry).
    const maxEnd = Math.min(tokens.length, i + MAX_SPAN);
    for (let end = maxEnd; end >= i + 2; end--) {
      const span = tokens.slice(i, end);
      const surface = span.map((t) => t.text).join("");
      if (COMPOUND_SET.has(surface.normalize("NFC"))) {
        out.push({
          text: surface,
          start: span[0].start,
          end: span[span.length - 1].end,
          // Fragment readings are already hiragana; concatenation is the compound
          // reading — but ONLY when every fragment had one (だい+きぼ=だいきぼ). A
          // missing fragment reading (common for the rarer compounds kuromoji
          // splits, e.g. 隕 in 隕石) would make a WRONG partial, so fall back to null
          // and let the dictionary reading fill it in (the reader overrides an
          // unambiguous dictionary reading onto the token anyway).
          reading: span.every((t) => t.reading) ? span.map((t) => t.reading).join("") : null,
          lemma: surface, // the compound IS its own dictionary form
          pos: "名詞", // a content POS → rendered as lookup-able vocabulary
        });
        i = end;
        merged = true;
        break;
      }
    }
    if (!merged) {
      out.push(tokens[i]);
      i += 1;
    }
  }
  return out;
}
