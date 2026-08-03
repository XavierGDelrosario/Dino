import { describe, expect, it } from "vitest";
import { FUNCTION_WORD_POS, functionWordPos } from "@/services/language/functionWords";
import { isContentPos } from "@/services/language";

describe("functionWordPos", () => {
  it("tags English closed-class words", () => {
    for (const w of ["the", "a", "of", "to", "and", "is", "were", "it", "not"]) {
      expect(functionWordPos(w, "EN")).toBe(FUNCTION_WORD_POS);
    }
  });

  it("leaves content words alone", () => {
    for (const w of ["cat", "station", "running", "quickly", "cold"]) {
      expect(functionWordPos(w, "EN")).toBeNull();
    }
  });

  it("is case-insensitive — a sentence-initial 'The' is the same grammar word", () => {
    // The reader keys meanings on the raw surface, so both spellings show up.
    expect(functionWordPos("The", "EN")).toBe(FUNCTION_WORD_POS);
    expect(functionWordPos("THE", "EN")).toBe(FUNCTION_WORD_POS);
  });

  it("matches contractions, which the tokenizer keeps whole", () => {
    for (const w of ["don't", "it's", "they're", "isn't"]) {
      expect(functionWordPos(w, "EN")).toBe(FUNCTION_WORD_POS);
    }
  });

  it("folds a curly apostrophe to a straight one", () => {
    expect(functionWordPos("don’t", "EN")).toBe(FUNCTION_WORD_POS);
  });

  describe("deliberate exclusions — a wrongly demoted word can never be learned", () => {
    it("keeps nouns that share a spelling with a modal", () => {
      // a can · the month May · a will. The tokenizer preserves capitalisation, so a
      // case-insensitive match would otherwise eat "May".
      for (const w of ["can", "may", "will", "May"]) {
        expect(functionWordPos(w, "EN")).toBeNull();
      }
    });

    it("keeps have/do — they are real content verbs", () => {
      for (const w of ["have", "has", "had", "do", "does", "did"]) {
        expect(functionWordPos(w, "EN")).toBeNull();
      }
    });

    it("keeps spatial/temporal and adverbial vocabulary", () => {
      for (const w of ["over", "under", "up", "down", "before", "after", "very", "there"]) {
        expect(functionWordPos(w, "EN")).toBeNull();
      }
    });
  });

  describe("other languages are untouched", () => {
    it("returns null for a language with no list — fail OPEN", () => {
      // Load-bearing: an unanalysed language must still show its words, not none.
      expect(functionWordPos("the", "KO")).toBeNull();
      expect(functionWordPos("de", "ES")).toBeNull();
      expect(functionWordPos("猫", "JA")).toBeNull();
    });
  });

  it("the synthetic pos is NOT a content pos — that's the whole mechanism", () => {
    expect(isContentPos(FUNCTION_WORD_POS)).toBe(false);
    expect(isContentPos(null)).toBe(true); // unanalysed language still counts
    expect(isContentPos("名詞")).toBe(true);
  });
});
