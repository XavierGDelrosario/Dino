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
