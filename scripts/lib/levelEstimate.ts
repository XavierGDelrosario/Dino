// =========================================================
// The level ESTIMATE for words the curated JLPT list doesn't carry — the pure rule,
// shared by scripts/apply-level-estimates.ts and its unit tests.
//
// A one-time calculation: the script fits this rule on the curated words, applies it to
// every unranked dictionary writing, and STORES the result (jmdict_kanji/kana.
// estimated_band, copied onto `words` by a trigger — migration 20260779). Nothing reads
// the rule at request time, so every surface shows one stored value and can't disagree.
// Re-run the script after re-ingesting the dictionary, frequency or proficiency data.
//
// THE RULE (measured 2026-09-28 on staging's full JMdict — docs/research/
// Level_Estimate_Gap_Fill.md). Each levelled word falls in a CELL:
//   word shape (kanji compound / katakana / other)
//   × on a NINJAL teaching list or not (data/teaching_vocab/ja.tsv)
//   × half-Zipf frequency bin.
// Frequency alone can't tell an N1 kanji compound from an N3 one at the same Zipf; the
// shape and the teaching lists can (off-list compounds at Zipf 3.5–5.0: 63% N1).
// In a word's cell:
//   · N3 when at least N3_SHARE of the cell's levelled words are N3 or easier — lean
//     easy, since a word shown too HARD is the costlier error (a test surprise);
//   · else N2 when N2 is at least N2_SHARE of the cell's N2+N1 words; else N1 — showing
//     an N2 word as N1 is tolerated (N2 is already advanced);
//   · never N5/N4 (unranked words are almost never basic), nothing below Zipf 3.0, and a
//     cell with too few levelled words falls back to frequency alone.
// =========================================================

export const EST_BIN_WIDTH = 50;   // Zipf ×100 per bin (half a Zipf)
export const EST_TOP_BIN = 12;     // Zipf 6.0+ pooled
export const EST_CUTOFF = 300;     // Zipf 3.0: rarer words stay unranked
export const EST_MIN_SUPPORT = 20; // a cell needs this many levelled words to speak
export const EST_N3_SHARE = 0.25;
export const EST_N2_SHARE = 0.35;

/** kuromoji's tags for one token — only the fields the name test reads. */
export interface TokenTags {
  pos: string;
  pos_detail_1: string;
  pos_detail_2: string;
}

/**
 * Is this writing a PLACE name rather than vocabulary — judged by how the analyzer tags
 * it ON ITS OWN? True for a writing of 2+ characters that is ONE token tagged
 * 固有名詞-地域 (台湾, インド, イタリア, アムステルダム, 東京). Places get no ESTIMATED level —
 * a band on 台湾 reads as "an N3 word". A curated band is untouched either way.
 *
 * PLACES ONLY, measured (staging, 2026-09-30, over the 18.7k estimated writings):
 *   · 地域 2+ chars: 418 — clean (countries, cities, regions).
 *   · 組織: 960 — mostly real loanwords IPADIC lists as company names (アイコン,
 *     アスリート, アウトレット). Excluding them would strip real words. (Cost: 松山 and
 *     広島 tag as 組織 — their sports teams — so they keep an estimate.)
 *   · 人名: ~400 — many real words (かおり "fragrance", あかり "light", キング, カイト).
 *   · single characters: ~200 — mostly words in their own right (米 rice, 露 dew).
 * (JMdict's own `place` tag can't do this: it marks only 2 entries below id 5,000,000.)
 */
export function isPlaceName(writing: string, tokens: readonly TokenTags[]): boolean {
  return (
    [...writing].length >= 2 &&
    tokens.length === 1 &&
    tokens[0].pos === "名詞" &&
    tokens[0].pos_detail_1 === "固有名詞" &&
    tokens[0].pos_detail_2 === "地域"
  );
}

export type WordShape = "kanji" | "katakana" | "other";

/** A kanji compound (2+ kanji), a katakana word, or anything else. */
export function wordShape(writing: string): WordShape {
  if (/^[\p{Script=Han}々]{2,}$/u.test(writing)) return "kanji";
  if (/^[ァ-ヶー・]+$/.test(writing)) return "katakana";
  return "other";
}

export const estimateBin = (frequency: number) =>
  Math.min(Math.floor(frequency / EST_BIN_WIDTH), EST_TOP_BIN);

/** A curated word the rule learns from. `band` is 1 (N5) … 5 (N1). */
export interface LevelledWord {
  writing: string;
  frequency: number;
  band: number;
  onTeachingList: boolean;
}

export type EstimateRule = (writing: string, frequency: number | null, onTeachingList: boolean) => number | null;

/** Fit the rule on the curated words. */
export function fitLevelEstimate(training: readonly LevelledWord[]): EstimateRule {
  const cells = new Map<string, number[]>();
  const bump = (key: string, band: number) => {
    const h = cells.get(key) ?? [0, 0, 0, 0, 0, 0];
    h[band]++;
    cells.set(key, h);
  };
  const cellKey = (w: string, list: boolean, f: number) => `${wordShape(w)}|${list ? 1 : 0}|${estimateBin(f)}`;
  for (const t of training) {
    if (t.band < 1 || t.band > 5) continue;
    bump(cellKey(t.writing, t.onTeachingList, t.frequency), t.band);
    bump(`*|${estimateBin(t.frequency)}`, t.band);
  }
  const total = (h: number[]) => h.reduce((a, b) => a + b, 0);

  return (writing, frequency, onTeachingList) => {
    if (frequency == null || frequency < EST_CUTOFF) return null;
    let h = cells.get(cellKey(writing, onTeachingList, frequency));
    if (!h || total(h) < EST_MIN_SUPPORT) h = cells.get(`*|${estimateBin(frequency)}`);
    if (!h || total(h) < EST_MIN_SUPPORT) return null;
    if ((h[1] + h[2] + h[3]) / total(h) >= EST_N3_SHARE) return 3;
    const advanced = h[4] + h[5];
    if (advanced === 0) return 3;
    return h[4] / advanced >= EST_N2_SHARE ? 4 : 5;
  };
}
