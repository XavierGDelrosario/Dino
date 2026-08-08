import { describe, it, expect } from "vitest";
import { toHiragana, searchTermFor } from "@/services/language";

// Typing "neko" while studying Japanese used to find nothing AND cost nothing to
// discover: jmdict_lookup misses on Latin, and the edge's off-script guard refuses to
// buy MT for Latin submitted as JA. Silence is the one answer that teaches the user
// nothing, so the search term is converted first.
describe("toHiragana", () => {
  it("converts ordinary words", () => {
    expect(toHiragana("neko")).toBe("ねこ");
    expect(toHiragana("sakana")).toBe("さかな");
    expect(toHiragana("tabemono")).toBe("たべもの");
  });

  it("handles digraphs before their parts (kya ≠ ka + ya)", () => {
    expect(toHiragana("kyou")).toBe("きょう");
    expect(toHiragana("shashin")).toBe("しゃしん");
    expect(toHiragana("chotto")).toBe("ちょっと");
  });

  it("accepts both romanizations of し/ち/つ/ふ/じ", () => {
    expect(toHiragana("shi")).toBe(toHiragana("si"));
    expect(toHiragana("chizu")).toBe("ちず");
    expect(toHiragana("tsukue")).toBe("つくえ");
    expect(toHiragana("fune")).toBe("ふね");
  });

  it("handles ん — bare, doubled, and apostrophe-disambiguated", () => {
    expect(toHiragana("hon")).toBe("ほん");
    expect(toHiragana("onna")).toBe("おんな");
    expect(toHiragana("hon'ya")).toBe("ほんや"); // not ほにゃ
    expect(toHiragana("kanji")).toBe("かんじ");
    expect(toHiragana("sannin")).toBe("さんにん"); // the 2nd n starts the next syllable
    expect(toHiragana("honn")).toBe("ほん"); // …except at the very end
  });

  it("maps a hyphen to the ー長音 mark, so loanwords are reachable", () => {
    // Readings store ー (ラーメン → らーめん), so without this no katakana word could be
    // found from romaji at all.
    expect(toHiragana("ra-men")).toBe("らーめん");
    expect(toHiragana("ko-hi-")).toBe("こーひー");
  });

  it("handles the っ sokuon", () => {
    expect(toHiragana("kitte")).toBe("きって");
    expect(toHiragana("gakkou")).toBe("がっこう");
  });

  it("is case-insensitive and trims", () => {
    expect(toHiragana("  NEKO  ")).toBe("ねこ");
  });

  // ALL-OR-NOTHING: a partial conversion is worse than none, because it fails in a way
  // that looks like a dictionary gap rather than a typo.
  it("returns null unless the WHOLE string converts", () => {
    expect(toHiragana("neko1")).toBeNull();
    expect(toHiragana("hello world")).toBeNull(); // space
    expect(toHiragana("xyz")).toBeNull();
    expect(toHiragana("")).toBeNull();
  });

  it("returns null for text that is already Japanese", () => {
    expect(toHiragana("猫")).toBeNull();
    expect(toHiragana("ねこ")).toBeNull();
    expect(toHiragana("neko猫")).toBeNull();
  });

  it("returns null for a dangling consonant", () => {
    expect(toHiragana("kk")).toBeNull();
    expect(toHiragana("k")).toBeNull();
  });

  // English words that happen to be valid romaji DO convert — which is exactly why the
  // caller only applies this when the user has said the source is Japanese.
  it("converts English words that are also valid romaji (hence the caller's guard)", () => {
    expect(toHiragana("same")).toBe("さめ");
    expect(toHiragana("kite")).toBe("きて");
  });
});

describe("searchTermFor", () => {
  it("converts only for Japanese", () => {
    expect(searchTermFor("neko", "JA")).toBe("ねこ");
    expect(searchTermFor("neko", "EN")).toBe("neko");
    expect(searchTermFor("neko", "auto")).toBe("neko"); // auto-detect never guesses
  });

  it("passes anything that doesn't convert straight through", () => {
    expect(searchTermFor("cat", "JA")).toBe("cat"); // 'c' alone is unmappable
    expect(searchTermFor("猫", "JA")).toBe("猫");
    expect(searchTermFor("hello world", "JA")).toBe("hello world");
  });
});
