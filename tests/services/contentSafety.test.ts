import { describe, it, expect } from "vitest";
import { isExplicitSuggestion } from "@/services/contentSafety";

describe("isExplicitSuggestion", () => {
  it("flags an explicit English gloss (the stryker→stripper case)", () => {
    expect(isExplicitSuggestion("ストリッパー", "stripper")).toBe(true);
    expect(isExplicitSuggestion("ポルノ", "porn; pornography")).toBe(true);
  });

  it("flags explicit Japanese writings by substring", () => {
    expect(isExplicitSuggestion("セックス", null)).toBe(true);
    expect(isExplicitSuggestion("痴漢", "groper")).toBe(true);
  });

  it("matches English as WHOLE words — no false positives on substrings", () => {
    expect(isExplicitSuggestion("クラス", "class")).toBe(false); // ⊅ "ass"
    expect(isExplicitSuggestion("通過", "pass; passage")).toBe(false);
    expect(isExplicitSuggestion("分析", "analysis")).toBe(false);
  });

  it("leaves ordinary words alone", () => {
    expect(isExplicitSuggestion("猫", "cat; feline")).toBe(false);
    expect(isExplicitSuggestion("ストライカー", "striker")).toBe(false); // the seed itself
    expect(isExplicitSuggestion(null, null)).toBe(false);
  });
});
