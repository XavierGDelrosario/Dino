import { describe, it, expect } from "vitest";
import {
  EST_CUTOFF,
  EST_MIN_SUPPORT,
  estimateBin,
  fitLevelEstimate,
  wordShape,
  type LevelledWord,
  isPlaceName,
} from "../../scripts/lib/levelEstimate";

/** `n` curated words of one shape / list status / frequency at `band`. */
const many = (n: number, writing: string, frequency: number, band: number, onTeachingList: boolean): LevelledWord[] =>
  Array.from({ length: n }, () => ({ writing, frequency, band, onTeachingList }));

describe("wordShape", () => {
  it("separates kanji compounds, katakana and the rest", () => {
    expect(wordShape("配属")).toBe("kanji");
    expect(wordShape("人々")).toBe("kanji");
    expect(wordShape("サッカー")).toBe("katakana");
    expect(wordShape("大げさ")).toBe("other");
    expect(wordShape("館")).toBe("other"); // a single kanji is not a compound
  });
});

describe("estimateBin", () => {
  it("is half-Zipf wide and pools Zipf 6.0+", () => {
    expect(estimateBin(349)).toBe(6);
    expect(estimateBin(350)).toBe(7);
    expect(estimateBin(650)).toBe(12);
    expect(estimateBin(900)).toBe(12);
  });
});

describe("fitLevelEstimate", () => {
  it("says N3 when a quarter of the cell is N3-or-easier (lean easy)", () => {
    const rule = fitLevelEstimate([...many(25, "配属", 420, 3, true), ...many(75, "配属", 420, 5, true)]);
    expect(rule("給付", 420, true)).toBe(3);
  });

  it("separates cells by teaching-list status: off-list compounds go advanced", () => {
    const rule = fitLevelEstimate([
      ...many(30, "配属", 420, 3, true),                                       // on a list: N3
      ...many(5, "苦悩", 420, 3, false), ...many(25, "苦悩", 420, 5, false),   // off-list: mostly N1
    ]);
    expect(rule("給付", 420, true)).toBe(3);
    expect(rule("給付", 420, false)).toBe(5);
  });

  it("picks N2 over N1 only when N2 holds enough of the advanced words (N2→N1 tolerated)", () => {
    const n2ish = fitLevelEstimate([...many(12, "配属", 420, 4, false), ...many(18, "配属", 420, 5, false)]);
    expect(n2ish("給付", 420, false)).toBe(4); // 12/30 = 0.40 ≥ 0.35
    const n1ish = fitLevelEstimate([...many(9, "配属", 420, 4, false), ...many(21, "配属", 420, 5, false)]);
    expect(n1ish("給付", 420, false)).toBe(5); // 9/30 = 0.30
  });

  it("never estimates below N3, below the cutoff, or without a frequency", () => {
    const rule = fitLevelEstimate(many(40, "水", 700, 1, true));
    expect(rule("茶", 700, true)).toBe(3);
    expect(rule("茶", EST_CUTOFF - 1, true)).toBeNull();
    expect(rule("茶", null, true)).toBeNull();
  });

  it("falls back to frequency alone when a cell is thin, and to nothing when the bin is too", () => {
    const rule = fitLevelEstimate([
      ...many(EST_MIN_SUPPORT, "大げさ", 420, 5, true),   // enough in the bin overall…
      ...many(3, "配属", 420, 3, false),                 // …but this cell is thin
    ]);
    expect(rule("給付", 420, false)).toBe(5); // uses the whole bin (3 of 23 easy < 0.25)
    expect(rule("給付", 600, false)).toBeNull(); // nothing measured at this frequency
  });
});

// Place names get NO estimated level (台湾 isn't "an N3 word"); other name tags are
// too noisy to trust — see isPlaceName for the measurement.
describe("isPlaceName", () => {
  const tok = (pos_detail_1: string, pos_detail_2: string, pos = "名詞") => ({ pos, pos_detail_1, pos_detail_2 });
  it("is true for a 2+ character writing that is one 固有名詞-地域 token", () => {
    expect(isPlaceName("台湾", [tok("固有名詞", "地域")])).toBe(true);
    expect(isPlaceName("アムステルダム", [tok("固有名詞", "地域")])).toBe(true);
  });
  it("is false for a single character — 米 is rice as often as America", () => {
    expect(isPlaceName("米", [tok("固有名詞", "地域")])).toBe(false);
  });
  it("is false for person / organization tags (real words hide there) and for 固有名詞-一般", () => {
    expect(isPlaceName("かおり", [tok("固有名詞", "人名")])).toBe(false); // "fragrance"
    expect(isPlaceName("アイコン", [tok("固有名詞", "組織")])).toBe(false);
    expect(isPlaceName("富士山", [tok("固有名詞", "一般")])).toBe(false);
  });
  it("is false for a common noun or a multi-token writing", () => {
    expect(isPlaceName("都市", [tok("一般", "*")])).toBe(false);
    expect(isPlaceName("大和村", [tok("固有名詞", "地域"), tok("接尾", "地域")])).toBe(false);
  });
});
