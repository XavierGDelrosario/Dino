// What we hand the synthesizer for a word. The whole point is that a stored reading
// beats the engine's guess on a homograph — but `input_reading` is a two-sided slot
// (kana over kanji for a normal entry, KANJI over kana for a "usually kana" one), so
// speaking it blindly would reintroduce the exact bug it prevents.
import { describe, it, expect } from "vitest";
import { pronounceableText } from "@/services/voice/pronounce";

const ja = (input: string, inputReading: string | null) => ({ input, inputReading, sourceLang: "JA" });

describe("pronounceableText", () => {
  it("speaks the kana reading of a kanji headword (the sense-correct pronunciation)", () => {
    expect(pronounceableText(ja("猫", "ねこ"))).toBe("ねこ");
  });

  it("gives a homograph the reading of the sense on screen", () => {
    // The whole reason this exists: 辛い is からい or つらい depending on the sense,
    // and the engine cannot know which card is showing.
    expect(pronounceableText(ja("辛い", "からい"))).toBe("からい");
    expect(pronounceableText(ja("辛い", "つらい"))).toBe("つらい");
  });

  it("speaks the headword for a 'usually kana' entry, whose reading slot holds KANJI", () => {
    // なる headlines as kana with 成る in the reading slot. Speaking the reading
    // would hand the engine kanji to guess at — the opposite of the intent.
    expect(pronounceableText(ja("なる", "成る"))).toBe("なる");
  });

  it("speaks the headword when there is no reading (kana-only or custom word)", () => {
    expect(pronounceableText(ja("ねこ", null))).toBe("ねこ");
    expect(pronounceableText(ja("ひらがな", ""))).toBe("ひらがな");
  });

  it("speaks an English term as-is — it is already its own pronunciation", () => {
    expect(pronounceableText({ input: "cat", inputReading: null, sourceLang: "EN" })).toBe("cat");
  });

  it("ignores a non-kana reading slot (romaji/pinyin annotations)", () => {
    expect(pronounceableText({ input: "爱", inputReading: "ài", sourceLang: "ZH" })).toBe("爱");
  });

  it("accepts katakana readings", () => {
    expect(pronounceableText(ja("珈琲", "コーヒー"))).toBe("コーヒー");
  });
});
