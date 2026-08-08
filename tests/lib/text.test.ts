import { describe, expect, it } from "vitest";
import { isKatakanaOnly, nfc, nfcTrim } from "@/lib/text";

describe("nfc / nfcTrim", () => {
  it("composes decomposed Japanese so cache keys can't fork", () => {
    // が as か + combining dakuten vs the precomposed character.
    expect(nfc("が")).toBe("が");
    expect(nfc("が").length).toBe(1);
  });

  it("nfcTrim also strips surrounding whitespace", () => {
    expect(nfcTrim("  猫 ")).toBe("猫");
  });
});

describe("isKatakanaOnly", () => {
  it("is true for katakana, including ー and the ・ joining a foreign name", () => {
    expect(isKatakanaOnly("リーグ")).toBe(true);
    expect(isKatakanaOnly("ゼレンスキー")).toBe(true);
    expect(isKatakanaOnly("イビチャ・オシム")).toBe(true);
    expect(isKatakanaOnly("ﾆｭｰｽ")).toBe(true); // halfwidth
  });

  it("is false for any other script, mixed text, or empty input", () => {
    expect(isKatakanaOnly("猫")).toBe(false);
    expect(isKatakanaOnly("ねこ")).toBe(false);
    expect(isKatakanaOnly("唐揚げ")).toBe(false); // kanji + kana
    expect(isKatakanaOnly("スマホ2")).toBe(false); // digit
    expect(isKatakanaOnly("Zelensky")).toBe(false);
    expect(isKatakanaOnly("")).toBe(false);
  });
});
