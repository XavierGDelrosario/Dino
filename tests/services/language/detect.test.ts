import { describe, it, expect } from "vitest";
import { detectLanguage, isAlreadyIn, resolveSourceLanguage, AUTO_DETECT } from "@/services/language/detect";

describe("isAlreadyIn", () => {
  it("English typed with the source set to Japanese is already English", () => {
    expect(isAlreadyIn("hello world", "EN", "JA")).toBe(true);
  });

  it("Japanese typed with the source set to English is already Japanese", () => {
    expect(isAlreadyIn("安倍晋三", "JA", "EN")).toBe(true);
  });

  it("an English text carrying one native-script name is NOT already Japanese", () => {
    expect(isAlreadyIn("Shinzo Abe (安倍晋三) said on Monday", "JA", "EN")).toBe(false);
    expect(isAlreadyIn("Xi Jinping (习近平) arrived", "JA", "EN")).toBe(false);
  });

  it("a Japanese text with a Latin word in it is NOT already English", () => {
    expect(isAlreadyIn("今日はDINOで勉強する", "EN", "JA")).toBe(false);
  });

  it("the same language on both sides is always already there", () => {
    expect(isAlreadyIn("anything", "EN", "EN")).toBe(true);
  });
});

describe("detectLanguage", () => {
  it("detects Japanese script", () => {
    expect(detectLanguage("ねこが好き")).toBe("JA");
    expect(detectLanguage("猫")).toBe("JA");
  });

  it("falls back to English for latin script", () => {
    expect(detectLanguage("hello world")).toBe("EN");
  });

  it("falls back to English for an empty string", () => {
    expect(detectLanguage("")).toBe("EN");
  });

  it("claims the text as soon as any character matches a script", () => {
    // A single Japanese character is enough for the JA matcher to win.
    expect(detectLanguage("abc 猫 123")).toBe("JA");
  });
});

describe("resolveSourceLanguage", () => {
  it("detects from text when the selection is AUTO_DETECT", () => {
    expect(resolveSourceLanguage("猫", AUTO_DETECT)).toBe("JA");
    expect(resolveSourceLanguage("cat", AUTO_DETECT)).toBe("EN");
  });

  it("uses the explicit selection without detecting", () => {
    // Text is Japanese but the user explicitly picked EN — honour the pick.
    expect(resolveSourceLanguage("猫", "EN")).toBe("EN");
    expect(resolveSourceLanguage("cat", "JA")).toBe("JA");
  });
});
