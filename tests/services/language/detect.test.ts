import { describe, it, expect } from "vitest";
import { detectLanguage, resolveSourceLanguage, AUTO_DETECT } from "@/services/language/detect";

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
