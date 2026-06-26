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

  it(
    'drops punctuation tokens — even ASCII quotes kuromoji mis-tags as 名詞 (no " word)',
    async () => {
      const texts = (await analyze('彼は"猫"と言った', "JA")).map((t) => t.text);
      expect(texts).toContain("猫"); // the real word survives
      expect(texts).not.toContain('"'); // the ASCII quote is not a token
      expect(texts.every((t) => /[\p{L}\p{N}]/u.test(t))).toBe(true); // no punctuation-only tokens
    },
    KUROMOJI_TIMEOUT
  );
});

describe("analyze — specific short words (今 / これ / 単語)", () => {
  it(
    "単語 → one content token read たんご (unambiguous)",
    async () => {
      const toks = await analyze("単語", "JA");
      expect(toks.map((t) => t.text)).toEqual(["単語"]);
      expect(toks[0].reading).toBe("たんご");
      expect(toks[0].pos).toBe("名詞"); // a content word (vocabulary in the reader)
    },
    KUROMOJI_TIMEOUT,
  );

  it(
    "これ → one token, hiragana reading これ",
    async () => {
      const toks = await analyze("これ", "JA");
      expect(toks.map((t) => t.text)).toEqual(["これ"]);
      expect(toks[0].reading).toBe("これ");
    },
    KUROMOJI_TIMEOUT,
  );

  it(
    "今 in isolation → one content token with a (best-effort) hiragana reading",
    async () => {
      // kuromoji is unreliable on a bare short token (may read 今 as こん, not いま —
      // a documented caveat). We assert only what's stable: one token, hiragana
      // reading present. The authoritative reading comes from `words`, not here.
      const toks = await analyze("今", "JA");
      expect(toks.map((t) => t.text)).toEqual(["今"]);
      expect(toks[0].reading).toBeTruthy();
      expect(toks[0].reading).not.toMatch(KATAKANA);
    },
    KUROMOJI_TIMEOUT,
  );
});

describe("analyze — non-Japanese falls back to segmentation only", () => {
  it("returns tokens with null reading/lemma for English", async () => {
    const toks = await analyze("hello world", "EN");
    expect(toks.map((t) => t.text)).toEqual(["hello", "world"]);
    expect(toks.every((t) => t.reading === null && t.lemma === null)).toBe(true);
  });
});
