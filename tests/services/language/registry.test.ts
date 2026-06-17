import { describe, it, expect } from "vitest";
import {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  isSupported,
} from "@/services/language/registry";

describe("registry", () => {
  it("ships Japanese (with a matcher) and English (the fallback, no matcher)", () => {
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    expect(codes).toContain("JA");
    expect(codes).toContain("EN");

    const ja = SUPPORTED_LANGUAGES.find((l) => l.code === "JA")!;
    const en = SUPPORTED_LANGUAGES.find((l) => l.code === "EN")!;
    expect(ja.matches).toBeTypeOf("function");
    expect(en.matches).toBeUndefined(); // fallback language has no script matcher
  });

  it("DEFAULT_LANGUAGE is a supported language", () => {
    expect(isSupported(DEFAULT_LANGUAGE)).toBe(true);
  });

  describe("Japanese script matcher", () => {
    const ja = SUPPORTED_LANGUAGES.find((l) => l.code === "JA")!;
    it.each([
      ["hiragana", "ねこ"],
      ["katakana", "ネコ"],
      ["kanji", "猫"],
      ["mixed with latin", "猫cat"],
    ])("matches %s", (_label, text) => {
      expect(ja.matches!(text)).toBe(true);
    });

    it("does not match plain latin text", () => {
      expect(ja.matches!("cat")).toBe(false);
    });
  });

  describe("isSupported", () => {
    it("is a case-sensitive exact match", () => {
      expect(isSupported("EN")).toBe(true);
      expect(isSupported("en")).toBe(false);
      expect(isSupported("ES")).toBe(false);
    });
  });
});
