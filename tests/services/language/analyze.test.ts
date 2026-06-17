import { describe, it, expect } from "vitest";
import { analyze } from "@/services/language/analyze";

// These exercise the REAL kuromoji engine (no mock): building the tokenizer
// loads the IPADIC dictionary on first use, hence the generous timeout. This is
// the leaf-engine test; orchestration callers (e.g. translateParagraph) mock
// `analyze` instead of paying this cost.
const KUROMOJI_TIMEOUT = 30_000;
const KATAKANA = /[ァ-ヶ]/;

describe("analyze — Japanese (kuromoji)", () => {
  it(
    "reads 今日 as きょう (hiragana) and keeps offsets pointed back into the source",
    async () => {
      const src = "今日行ったよ";
      const toks = await analyze(src, "JA");

      expect(toks.find((t) => t.text === "今日")?.reading).toBe("きょう");
      for (const t of toks) {
        expect(src.slice(t.start, t.end)).toBe(t.text); // offsets are correct
        if (t.reading) expect(t.reading).not.toMatch(KATAKANA); // hiragana, not katakana
      }
    },
    KUROMOJI_TIMEOUT
  );

  it(
    "lemmatizes a conjugated verb — the thing Intl.Segmenter cannot do",
    async () => {
      const toks = await analyze("今日行ったよ", "JA");
      const verb = toks.find((t) => t.text.startsWith("行"));
      expect(verb).toBeDefined();
      // A base form is recovered and differs from the inflected surface (行っ → 行う).
      // (We don't pin the exact lemma: 行った is genuinely ambiguous in isolation.)
      expect(verb?.lemma).toBeTruthy();
      expect(verb?.lemma).not.toBe(verb?.text);
    },
    KUROMOJI_TIMEOUT
  );

  it(
    "segments the ambiguous 今日曜日だよ as 今 / 日曜日, not the greedy 今日 + 曜日",
    async () => {
      const texts = (await analyze("今日曜日だよ", "JA")).map((t) => t.text);
      expect(texts).toContain("日曜日");
      expect(texts).toContain("今");
      expect(texts).not.toContain("今日"); // the wrong greedy split did not happen
    },
    KUROMOJI_TIMEOUT
  );
});

describe("analyze — non-Japanese falls back to segmentation only", () => {
  it("returns tokens with null reading/lemma for English", async () => {
    const toks = await analyze("hello world", "EN");
    expect(toks.map((t) => t.text)).toEqual(["hello", "world"]);
    expect(toks.every((t) => t.reading === null && t.lemma === null)).toBe(true);
  });
});
