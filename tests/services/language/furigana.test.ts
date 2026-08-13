import { describe, it, expect } from "vitest";
import { displayHeadword, furiganaFor } from "@/services/language/furigana";

const entry = (over: Partial<Parameters<typeof furiganaFor>[0]> = {}) => ({
  input: "猫",
  translation: "cat",
  inputReading: null,
  translationReading: null,
  ...over,
});

describe("furiganaFor", () => {
  it("annotates the input side (JA→EN)", () => {
    expect(furiganaFor(entry({ inputReading: "ねこ" }))).toEqual([
      { side: "input", term: "猫", reading: "ねこ" },
    ]);
  });

  it("annotates the translation side (EN→JA)", () => {
    expect(
      furiganaFor(entry({ input: "cat", translation: "猫", translationReading: "ねこ" }))
    ).toEqual([{ side: "translation", term: "猫", reading: "ねこ" }]);
  });

  it("annotates both sides (JA→ZH: kana + pinyin)", () => {
    expect(
      furiganaFor(entry({ translation: "猫", inputReading: "ねこ", translationReading: "māo" }))
    ).toEqual([
      { side: "input", term: "猫", reading: "ねこ" },
      { side: "translation", term: "猫", reading: "māo" },
    ]);
  });

  it("returns [] when neither side has a reading", () => {
    expect(furiganaFor(entry())).toEqual([]);
  });
});

describe("displayHeadword — which side headlines a uk entry", () => {
  // 概ね is JMdict `uk`, so it is STORED inverted: headword おおむね, kanji in the
  // annotation. Searching the kanji then reads "the reading of おおむね is 概ね" —
  // quality report #17.
  const uk = { input: "おおむね", translation: "in general", inputReading: "概ね", translationReading: null };
  // An ordinary entry: kanji headword, kana annotation.
  const plain = { input: "猫", translation: "cat", inputReading: "ねこ", translationReading: null };

  it("swaps when the search term IS the kanji sitting in the annotation slot", () => {
    expect(displayHeadword(uk, "概ね")).toEqual({ head: "概ね", reading: "おおむね" });
  });

  it("leaves the uk default alone when the kana was searched", () => {
    expect(displayHeadword(uk, "おおむね")).toEqual({ head: "おおむね", reading: "概ね" });
  });

  it("never flips an ordinary entry searched by its reading", () => {
    // The guard that makes this narrow: ねこ has no kanji, so 猫[ねこ] stands.
    expect(displayHeadword(plain, "ねこ")).toEqual({ head: "猫", reading: "ねこ" });
    expect(displayHeadword(plain, "猫")).toEqual({ head: "猫", reading: "ねこ" });
  });

  it("is the stored row verbatim with no query (every caller that has none)", () => {
    expect(displayHeadword(uk)).toEqual({ head: "おおむね", reading: "概ね" });
    expect(displayHeadword(plain, null)).toEqual({ head: "猫", reading: "ねこ" });
  });

  it("matches on NFC and ignores surrounding whitespace", () => {
    expect(displayHeadword(uk, " 概ね ")).toEqual({ head: "概ね", reading: "おおむね" });
  });

  it("handles a row with no reading at all", () => {
    const bare = { input: "cat", translation: "猫", inputReading: null, translationReading: "ねこ" };
    expect(displayHeadword(bare, "cat")).toEqual({ head: "cat", reading: null });
  });
});
