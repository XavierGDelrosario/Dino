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

// Verified (2026-07-03, raw kuromoji IPADIC) to be over-segmented, plus close
// analogues that share the same IPADIC gap (the ～活 neologisms; the ～規模 scale
// compounds). Keep NFC-normalized.
export const JA_COMPOUNDS: readonly string[] = [
  // scale compounds (名詞): 大 is a 接頭詞 kuromoji splits off
  "大規模",
  "小規模",
  "中規模",
  // ～活 neologisms absent from IPADIC → split into single kanji
  "婚活",
  "就活",
  "終活",
  "妊活",
  "朝活",
  // adverb: kuromoji peels the adverbializing 助詞 に off the 主 stem
  "主に",
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
          // reading. Null only if every fragment lacked one.
          reading: span.map((t) => t.reading ?? "").join("") || null,
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
