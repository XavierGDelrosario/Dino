import { describe, it, expect } from "vitest";
import { mergeJapaneseCompounds } from "@/services/language/compounds";
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
