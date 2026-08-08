import { describe, it, expect } from "vitest";
import { isKanaOnly, makeSearchMatcher, type SearchTarget } from "@/services/words/search";

const word = (w: Partial<SearchTarget>): SearchTarget => ({
  input: "猫",
  translation: "cat",
  inputReading: "ねこ",
  sourceLang: "JA",
  ...w,
});

const NEKO = word({});
const INU = word({ input: "犬", translation: "dog", inputReading: "いぬ" });
const RAMEN = word({ input: "ラーメン", translation: "ramen", inputReading: null });
const CUSTOM = word({ input: "頑張る", translation: "to do one's best", inputReading: "がんばる" });

const matches = (query: string, ws: SearchTarget[]) => ws.filter(makeSearchMatcher(query)).map((w) => w.input);

describe("makeSearchMatcher", () => {
  it("matches the headword", () => {
    expect(matches("猫", [NEKO, INU])).toEqual(["猫"]);
  });

  it("matches the meaning, case-insensitively and on a substring", () => {
    expect(matches("dog", [NEKO, INU])).toEqual(["犬"]);
    expect(matches("BEST", [NEKO, CUSTOM])).toEqual(["頑張る"]);
    expect(matches("one's", [NEKO, CUSTOM])).toEqual(["頑張る"]);
  });

  it("matches the READING for a kana query — the whole point (you can't type 猫 without the kanji)", () => {
    expect(matches("ねこ", [NEKO, INU])).toEqual(["猫"]);
    expect(matches("がんば", [NEKO, CUSTOM])).toEqual(["頑張る"]); // substring of the reading
  });

  it("folds katakana to hiragana, so either script finds the word", () => {
    expect(matches("ネコ", [NEKO, INU])).toEqual(["猫"]); // katakana query → hiragana reading
    expect(matches("らーめん", [RAMEN, NEKO])).toEqual(["ラーメン"]); // hiragana query → katakana headword
  });

  it("does NOT search readings for a non-kana query — 'no' must not hit every word containing の", () => {
    const NOMU = word({ input: "飲む", translation: "to drink", inputReading: "のむ" });
    // "no" is English here: it may match a meaning, but never a reading.
    expect(matches("no", [NOMU, NEKO, INU])).toEqual([]);
    // …while the kana query does reach the reading.
    expect(matches("のむ", [NOMU, NEKO])).toEqual(["飲む"]);
  });

  it("tolerates a word with no reading (a custom/standalone word)", () => {
    const OWN = word({ input: "MyWord", translation: "my meaning", inputReading: null });
    expect(matches("ねこ", [OWN])).toEqual([]);
    expect(matches("myword", [OWN])).toEqual(["MyWord"]);
  });

  it("matches everything on a blank query, so the caller can apply it unconditionally", () => {
    for (const q of ["", "   "]) {
      expect(matches(q, [NEKO, INU, RAMEN])).toEqual(["猫", "犬", "ラーメン"]);
    }
  });

  it("trims and NFC-normalizes the query (the app's storage convention)", () => {
    expect(matches("  ねこ  ", [NEKO, INU])).toEqual(["猫"]);
  });
});

// ROMAJI: the same search by sound, typed on a keyboard with no kana. The point of the
// feature — you cannot type 猫 without an IME, and you may not know ねこ yet either.
describe("makeSearchMatcher — romaji", () => {
  it("finds a word by its reading typed in romaji", () => {
    expect(matches("neko", [NEKO, INU])).toEqual(["猫"]);
    expect(matches("inu", [NEKO, INU])).toEqual(["犬"]);
    expect(matches("ganbaru", [NEKO, CUSTOM])).toEqual(["頑張る"]);
  });

  it("matches a kana HEADWORD too (ラーメン ← ramen), not just a reading", () => {
    expect(matches("ra-men", [NEKO, RAMEN])).toEqual(["ラーメン"]); // hyphen = ー
  });

  // The gate: one kana matches a huge share of a vocabulary, and English function words
  // are all valid romaji. Keyed on the RESULT length, not the input length.
  it("ignores a query that converts to a SINGLE kana (no · to · wa · ka)", () => {
    // A meaning without the query in it, so only the reading path could match.
    const NOMU = word({ input: "飲む", translation: "drink", inputReading: "のむ" });
    expect(matches("no", [NOMU])).toEqual([]);
    expect(matches("wa", [NOMU])).toEqual([]);
  });

  it("leaves ordinary English alone — it never converts, so the path is inert", () => {
    expect(matches("cat", [NEKO, INU])).toEqual(["猫"]); // by MEANING, as before
    expect(matches("hello", [NEKO, INU])).toEqual([]);
  });

  // Deliberately not matched against meanings: "same" is valid romaji (さめ), and
  // searching English meanings with it too would drag in every word defined with "same".
  it("does not apply the romaji form to meanings", () => {
    const SAMENESS = word({ input: "同一", translation: "the same thing", inputReading: "どういつ" });
    expect(matches("same", [SAMENESS])).toEqual(["同一"]); // literal meaning hit only
  });
});

describe("isKanaOnly", () => {
  it("is true for hiragana, katakana, and the ー mark", () => {
    expect(isKanaOnly("ねこ")).toBe(true);
    expect(isKanaOnly("ネコ")).toBe(true);
    expect(isKanaOnly("ラーメン")).toBe(true);
  });

  it("is false for kanji, latin, mixed, and empty", () => {
    expect(isKanaOnly("猫")).toBe(false);
    expect(isKanaOnly("cat")).toBe(false);
    expect(isKanaOnly("ねこ猫")).toBe(false);
    expect(isKanaOnly("")).toBe(false);
  });
});
