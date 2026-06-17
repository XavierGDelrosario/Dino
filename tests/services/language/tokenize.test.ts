import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tokenizeWords } from "@/services/language/tokenize";

describe("tokenizeWords (Intl.Segmenter present)", () => {
  it("segments spaced English and keeps offsets", () => {
    const tokens = tokenizeWords("hello world", "EN");
    expect(tokens.map((t) => t.text)).toEqual(["hello", "world"]);
    expect(tokens[0]).toMatchObject({ text: "hello", start: 0, end: 5 });
    expect(tokens[1]).toMatchObject({ text: "world", start: 6, end: 11 });
  });

  it("drops punctuation and whitespace (word-like only)", () => {
    const tokens = tokenizeWords("cat, dog!", "EN");
    expect(tokens.map((t) => t.text)).toEqual(["cat", "dog"]);
  });

  it("segments space-less Japanese into multiple words", () => {
    // Without Segmenter this whole run would be one token; with it, several.
    const tokens = tokenizeWords("猫が好き", "JA");
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.map((t) => t.text).join("")).toContain("猫");
    // Offsets must point back into the source string.
    for (const t of tokens) {
      expect("猫が好き".slice(t.start, t.end)).toBe(t.text);
    }
  });

  it("returns [] for whitespace-only input", () => {
    expect(tokenizeWords("   ", "EN")).toEqual([]);
  });
});

describe("tokenizeWords (regex fallback when Segmenter is missing)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to a Unicode word regex for spaced languages", async () => {
    // The module captures Intl.Segmenter at load time, so stub it BEFORE import.
    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    const { tokenizeWords: fallbackTokenize } = await import("@/services/language/tokenize");

    const tokens = fallbackTokenize("hello world", "EN");
    expect(tokens.map((t) => t.text)).toEqual(["hello", "world"]);
    expect(tokens[1]).toMatchObject({ start: 6, end: 11 });
  });
});
