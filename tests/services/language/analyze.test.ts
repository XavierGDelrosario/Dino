import { describe, it, expect } from "vitest";
import { analyze, dictionaryForm, isContentPos, isSingleWord } from "@/services/language/analyze";

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
  it(
    "embedded Latin acronyms (QR / URL) are kept but marked non-content (plain text)",
    async () => {
      const toks = await analyze("QRコードとURLを確認", "JA");
      const byText = (s: string) => toks.find((t) => t.text === s);
      // The acronyms survive as tokens (visible in the reader)…
      expect(byText("QR")).toBeDefined();
      expect(byText("URL")).toBeDefined();
      // …but are NOT content words, so the reader renders them plain & non-addable.
      expect(isContentPos(byText("QR")!.pos)).toBe(false);
      expect(isContentPos(byText("URL")!.pos)).toBe(false);
      // A katakana loanword in the same sentence stays real vocabulary.
      expect(isContentPos(byText("コード")!.pos)).toBe(true);
    },
    KUROMOJI_TIMEOUT,
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

// Japanese counter (助数詞) readings — kuromoji splits a number+counter into two tokens
// and gives each its CITATION reading; the counters/ resolver rewrites them in analyze's
// post-pass (euphonic 本→ぼん/ぽん, irregular 一人→ひとり). See src/services/language/counters/.
describe("analyze — Japanese counter readings (助数詞)", () => {
  const reading = async (src: string) => (await analyze(src, "JA")).map((t) => t.reading).join("");
  it("applies euphonic counter changes (三本 → さんぼん, 三杯 → さんばい, 十個 → じゅっこ)", async () => {
    expect(await reading("三本")).toBe("さんぼん");
    expect(await reading("三杯")).toBe("さんばい");
    expect(await reading("十個")).toBe("じゅっこ");
  }, KUROMOJI_TIMEOUT);
  it("handles irregular people-counter readings (一人 → ひとり, 二人 → ふたり)", async () => {
    expect(await reading("一人")).toBe("ひとり");
    expect(await reading("二人")).toBe("ふたり");
  }, KUROMOJI_TIMEOUT);

  it("thorough tier: pOn3 / wago / 時 / 日 / multi-token jukujikun", async () => {
    expect(await reading("三分")).toBe("さんぷん"); // pOn3 (p, not ぶ)
    expect(await reading("一晩")).toBe("ひとばん"); // wago native numeral
    expect(await reading("四時")).toBe("よじ"); //     per-digit number reading
    expect(await reading("一日")).toBe("ついたち"); // suppletive 日 series
    // 二十歳 → はたち across THREE tokens (二十歳): the replacesRun path must blank 二/十
    // correctly (regression guard — naive last-token rewrite would give にはたち).
    expect(await reading("二十歳")).toBe("はたち");
  }, KUROMOJI_TIMEOUT);

  it(
    "distinguishes 本 as counter vs noun in ONE sentence (六本 merged → ろっぽん, 本 noun → ほん)",
    async () => {
      // 六本(rokuPPON, counter) 鉛筆 と 一冊(issatsu) 本(hon, noun "book") 買った。
      const toks = await analyze("六本鉛筆と一冊本買った。", "JA");
      const find = (s: string) => toks.find((t) => t.text === s);
      // The counter 六本 is now ONE composite token, group-ruby ろっぽん, pointing at 本.
      expect(find("六本")).toMatchObject({ reading: "ろっぽん", lemma: "本", composite: true });
      expect(find("一冊")).toMatchObject({ reading: "いっさつ", lemma: "冊", composite: true });
      // The standalone noun 本 stays its own (non-composite) token, read ほん.
      expect(find("本")).toMatchObject({ reading: "ほん" });
      expect(find("本")?.composite).toBeFalsy();
      // The number is absorbed — no bare 六/一 tokens remain.
      expect(find("六")).toBeUndefined();
    },
    KUROMOJI_TIMEOUT,
  );

  it(
    "a lone number+counter routes to the reader, not single-word lookup (isSingleWord=false)",
    async () => {
      const toks = await analyze("三本", "JA");
      expect(toks).toHaveLength(1);
      expect(toks[0]).toMatchObject({ text: "三本", reading: "さんぼん", lemma: "本", composite: true });
      expect(isSingleWord(toks, "JA")).toBe(false); // composite → sentence path
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

// The dictionary-form rule the paragraph reader, Translate, and the Lists add form
// all share: look an inflected surface up under its LEMMA, because the dictionary
// is keyed on dictionary forms.
describe("dictionaryForm", () => {
  it(
    "resolves an inflected Japanese word to its dictionary form",
    async () => {
      expect(await dictionaryForm("行った", "JA")).toBe("行く");
      expect(await dictionaryForm("食べました", "JA")).toBe("食べる");
    },
    KUROMOJI_TIMEOUT
  );

  it(
    "leaves a word already in dictionary form alone",
    async () => {
      expect(await dictionaryForm("行く", "JA")).toBe("行く");
    },
    KUROMOJI_TIMEOUT
  );

  it(
    "leaves a PHRASE alone (it belongs to the reader, which lemmatizes per token)",
    async () => {
      const phrase = "日本に行った";
      expect(await dictionaryForm(phrase, "JA")).toBe(phrase);
    },
    KUROMOJI_TIMEOUT
  );

  it("returns English UNCHANGED — no engine gives English lemmas (a known gap)", async () => {
    expect(await dictionaryForm("ran", "EN")).toBe("ran");
    expect(await dictionaryForm("running", "EN")).toBe("running");
  });
});
