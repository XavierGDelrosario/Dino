import { describe, it, expect } from "vitest";
import {
  mergeJapaneseCompounds,
  dictionaryCompoundCandidates,
  mergeConfirmedCompounds,
} from "@/services/language/compounds";
import { analyze } from "@/services/language/analyze";
import type { AnalyzedToken } from "@/services/language/analyze";

// Build a fragment token stream as kuromoji would emit it (consecutive, offsets
// chained), so the pure merge can be tested without loading the ~12MB engine.
function frags(...parts: Array<[string, string | null]>): AnalyzedToken[] {
  let pos = 0;
  return parts.map(([text, reading]) => {
    const start = pos;
    pos += text.length;
    return { text, start, end: pos, reading, lemma: text, pos: "名詞" };
  });
}

describe("mergeJapaneseCompounds — pure merge", () => {
  it("merges a split compound into one token with concatenated reading + offsets", () => {
    const out = mergeJapaneseCompounds(frags(["婚", "こん"], ["活", "かつ"]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      text: "婚活",
      reading: "こんかつ",
      lemma: "婚活",
      pos: "名詞",
      start: 0,
      end: 2,
    });
  });

  it("merges the adverb 主に (stem + adverbializing particle)", () => {
    const out = mergeJapaneseCompounds(frags(["主", "おも"], ["に", "に"]));
    expect(out.map((t) => t.text)).toEqual(["主に"]);
    expect(out[0].reading).toBe("おもに");
  });

  it("merges every karaage form kuromoji over-segments (唐揚げ / から揚げ / からあげ)", () => {
    // kuromoji splits 唐揚げ → 唐:とう ＋ 揚げ (the concatenated reading とうあげ is wrong,
    // but the reader's single-reading dictionary override corrects it to からあげ).
    expect(mergeJapaneseCompounds(frags(["唐", "とう"], ["揚げ", "あげ"])).map((t) => t.text)).toEqual(["唐揚げ"]);
    expect(mergeJapaneseCompounds(frags(["から", "から"], ["揚げ", "あげ"])).map((t) => t.text)).toEqual(["から揚げ"]);
    expect(mergeJapaneseCompounds(frags(["から", "から"], ["あげ", "あげ"])).map((t) => t.text)).toEqual(["からあげ"]);
  });

  it("merges only the listed compound, leaving surrounding tokens untouched", () => {
    const out = mergeJapaneseCompounds(
      frags(["次", "じ"], ["大", "だい"], ["規模", "きぼ"], ["だ", "だ"]),
    );
    expect(out.map((t) => t.text)).toEqual(["次", "大規模", "だ"]);
    expect(out.find((t) => t.text === "大規模")?.reading).toBe("だいきぼ");
  });

  it("does NOT merge tokens that don't form a listed compound", () => {
    const before = frags(["大", "だい"], ["学", "がく"]); // 大学 is not in the list
    const out = mergeJapaneseCompounds(before);
    expect(out.map((t) => t.text)).toEqual(["大", "学"]);
  });

  it("preserves total surface text (no loss) even when nothing merges", () => {
    const out = mergeJapaneseCompounds(frags(["犬", "いぬ"], ["猫", "ねこ"]));
    expect(out.map((t) => t.text).join("")).toBe("犬猫");
  });

  it("yields a null reading (not a wrong partial) when a fragment lacks one", () => {
    // 隕石: kuromoji gives 隕 no reading, 石 → せき; concatenating would be the WRONG
    // せき, so the merged reading must be null (the dictionary reading fills it in).
    const out = mergeJapaneseCompounds(frags(["隕", null], ["石", "せき"]));
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("隕石");
    expect(out[0].reading).toBeNull();
  });
});

describe("mergeJapaneseCompounds — via real kuromoji (analyze)", () => {
  const T = 30_000;

  it("resolves 大規模 as ONE token with reading だいきぼ", async () => {
    const toks = await analyze("大規模", "JA");
    expect(toks.map((t) => t.text)).toEqual(["大規模"]);
    expect(toks[0].reading).toBe("だいきぼ");
  }, T);

  it("resolves 婚活 as ONE token (だいきぼ-style compound) instead of 婚 + 活", async () => {
    const toks = await analyze("婚活", "JA");
    expect(toks.map((t) => t.text)).toEqual(["婚活"]);
    expect(toks[0].reading).toBe("こんかつ");
  }, T);

  it("resolves 主に as ONE adverb token reading おもに", async () => {
    const toks = await analyze("主に", "JA");
    expect(toks.map((t) => t.text)).toEqual(["主に"]);
    expect(toks[0].reading).toBe("おもに");
  }, T);

  it("merges a seeded general compound (隕石) into one token", async () => {
    const toks = await analyze("隕石", "JA");
    expect(toks.map((t) => t.text)).toEqual(["隕石"]);
  }, T);

  it("keeps 大規模 and 婚活 whole inside a longer run", async () => {
    const toks = await analyze("主に大規模な婚活", "JA");
    const surfaces = toks.map((t) => t.text);
    expect(surfaces).toContain("大規模");
    expect(surfaces).toContain("婚活");
    expect(surfaces).toContain("主に");
    // no loss of source text
    expect(surfaces.join("")).toBe("主に大規模な婚活");
  }, T);
});

// ---------------------------------------------------------------------------
// Dictionary-validated merge — the general fix for compounds the curated list
// above will never enumerate. These are the two words from the quality reports
// (柔軟剤, 電子レンジ): both ARE full-JMdict entries that kuromoji splits.
// ---------------------------------------------------------------------------

describe("dictionaryCompoundCandidates — what we ask the dictionary about", () => {
  it("proposes the 2- and 3-token runs of a noun sequence", () => {
    const cands = dictionaryCompoundCandidates(frags(["柔軟", "じゅうなん"], ["剤", "ざい"]));
    expect(cands).toEqual(["柔軟剤"]);
  });

  it("never joins across a gap in the source (whitespace/punctuation)", () => {
    // Two nouns that WOULD concatenate to a real word, but aren't adjacent.
    const toks = frags(["電子", "でんし"], ["レンジ", "れんじ"]);
    toks[1].start += 1; // a space between them
    toks[1].end += 1;
    expect(dictionaryCompoundCandidates(toks)).toEqual([]);
  });

  it("does not propose non-noun tokens (particles, verbs) as compound parts", () => {
    const toks = frags(["柔軟", "じゅうなん"], ["剤", "ざい"]);
    toks[0].pos = "助詞";
    expect(dictionaryCompoundCandidates(toks)).toEqual([]);
  });

  it("stops a run at the first non-noun rather than skipping over it", () => {
    const toks = frags(["電子", "でんし"], ["を", "を"], ["レンジ", "れんじ"]);
    toks[1].pos = "助詞";
    expect(dictionaryCompoundCandidates(toks)).toEqual([]);
  });

  it("caps how many candidates a pathological wall of nouns can produce", () => {
    const many = frags(...Array.from({ length: 1000 }, (_, i) => [`名${i}`, null] as [string, null]));
    expect(dictionaryCompoundCandidates(many).length).toBeLessThanOrEqual(256);
  });

  it("does not truncate a MAX-LENGTH paragraph at worst-case noun density", () => {
    // The cap is a backstop, not a working limit: a 2000-char paste (the upstream
    // paragraph limit) at the densest real density we've measured (~0.08
    // candidates/char, from quality report #3) must still fit under it.
    const worstCaseCandidates = Math.ceil(2000 * 0.08);
    const dense = frags(...Array.from(
      { length: worstCaseCandidates + 2 },
      (_, i) => [`名${i}`, null] as [string, null],
    ));
    expect(dictionaryCompoundCandidates(dense).length).toBeGreaterThan(worstCaseCandidates);
  });
});

describe("mergeConfirmedCompounds — folding what the dictionary confirmed", () => {
  it("merges 柔軟 ＋ 剤 into 柔軟剤 with the concatenated reading", () => {
    const out = mergeConfirmedCompounds(
      frags(["柔軟", "じゅうなん"], ["剤", "ざい"]),
      new Set(["柔軟剤"]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("柔軟剤");
    expect(out[0].reading).toBe("じゅうなんざい");
    expect(out[0].lemma).toBe("柔軟剤"); // the compound is its own dictionary form
    expect(out[0].end).toBe(3); // offsets still span the source
  });

  it("merges a katakana compound (電子レンジ)", () => {
    const out = mergeConfirmedCompounds(
      frags(["電子", "でんし"], ["レンジ", "れんじ"]),
      new Set(["電子レンジ"]),
    );
    expect(out.map((t) => t.text)).toEqual(["電子レンジ"]);
  });

  it("leaves fragments alone when the dictionary confirmed nothing", () => {
    // 漢方 ＋ 製剤 is NOT a JMdict entry — it must stay split, not be invented.
    const toks = frags(["漢方", "かんぽう"], ["製剤", "せいざい"]);
    expect(mergeConfirmedCompounds(toks, new Set()).map((t) => t.text))
      .toEqual(["漢方", "製剤"]);
  });

  it("prefers the LONGEST confirmed compound when both a 2- and 3-run match", () => {
    const out = mergeConfirmedCompounds(
      frags(["登録", "とうろく"], ["販売", "はんばい"], ["者", "しゃ"]),
      new Set(["登録販売", "登録販売者"]),
    );
    expect(out.map((t) => t.text)).toEqual(["登録販売者"]);
  });

  it("drops the reading rather than inventing a partial one", () => {
    const out = mergeConfirmedCompounds(
      frags(["柔軟", "じゅうなん"], ["剤", null]),
      new Set(["柔軟剤"]),
    );
    expect(out[0].reading).toBeNull(); // dictionary reading fills this in downstream
  });

  it("loses no source text when only part of a sentence merges", () => {
    const toks = frags(["柔軟", "じゅうなん"], ["剤", "ざい"], ["を", "を"], ["買う", "かう"]);
    toks[2].pos = "助詞";
    const out = mergeConfirmedCompounds(toks, new Set(["柔軟剤"]));
    expect(out.map((t) => t.text).join("")).toBe("柔軟剤を買う");
  });
});

describe("the reported bug, end to end through the real analyzer", () => {
  const T = 30_000; // building the real kuromoji tokenizer loads the IPADIC dict

  it("kuromoji really does split both reported words (the bug exists)", async () => {
    expect((await analyze("柔軟剤", "JA")).length).toBeGreaterThan(1);
    expect((await analyze("電子レンジ", "JA")).length).toBeGreaterThan(1);
  }, T);

  it("and the dictionary-confirmed merge puts them back together", async () => {
    for (const [word, reading] of [["柔軟剤", "じゅうなんざい"], ["電子レンジ", "でんしれんじ"]]) {
      const toks = await analyze(word, "JA");
      const cands = dictionaryCompoundCandidates(toks);
      expect(cands).toContain(word); // we would ask the dictionary about it
      const merged = mergeConfirmedCompounds(toks, new Set([word]));
      expect(merged.map((t) => t.text)).toEqual([word]);
      expect(merged[0].reading).toBe(reading);
    }
  }, T);
});
