import { describe, it, expect } from "vitest";
import { furiganaFor } from "@/services/language/furigana";

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
