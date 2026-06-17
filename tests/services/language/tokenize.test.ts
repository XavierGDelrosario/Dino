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

// =========================================================
// Known segmentation limits — DOCUMENTED, not failures.
//
// The `words` cache and its readings are whole-entry and correct; the weak link
// is segmentation. Intl.Segmenter is dictionary-based and context-FREE, so it
// can't lemmatize (行った -> 行く) and can mis-split ambiguous runs. A reading
// composed from these tokens would therefore be MISSING (conjugations) or, on a
// bad split, WRONG. These tests pin the current behavior so the gap is visible;
// the real fix is a morphological analyzer (kuromoji) — see the skipped target.
//
// NOTE: exact tokens are ICU-version dependent. If ICU improves and one of these
// breaks, that's a signal to revisit (likely delete), not a regression.
// =========================================================
describe("tokenizeWords — morphological gaps (deferred to a morphological analyzer)", () => {
  it("loses a conjugated verb: 今日行ったよ shreds 行った, so its reading is unrecoverable", () => {
    // Observed: ["今日","行","っ","たよ"] — 今日 survives (=きょう), but the verb
    // 行った is split into fragments; no token is 行った or its dict form 行く.
    const tokens = tokenizeWords("今日行ったよ", "JA").map((t) => t.text);
    expect(tokens).toContain("今日"); // the compound that did survive
    expect(tokens).not.toContain("行った"); // surface form is gone…
    expect(tokens).not.toContain("行く"); // …and there's no lemmatization to recover it
  });

  it("happens to disambiguate 今日曜日だよ correctly (今 / 日曜日), but only by luck of the model", () => {
    // Observed: ["今","日曜日","だ","よ"] — the RIGHT parse (今=いま, 日曜日=にちようび),
    // NOT the greedy mis-parse 今日(きょう)+曜日. Context-free, so not guaranteed.
    const tokens = tokenizeWords("今日曜日だよ", "JA").map((t) => t.text);
    expect(tokens).toContain("日曜日");
    expect(tokens).toContain("今");
    expect(tokens).not.toContain("今日"); // the wrong greedy split did NOT happen here
  });

  // The target a morphological analyzer must hit: same 今日 read two different
  // ways by context, plus the verb lemmatized. Unskip when kuromoji lands.
  it.skip("morphological analyzer yields correct per-token readings (kuromoji milestone)", () => {
    // 今日行ったよ → 今日=きょう / 行った=いった / よ
    // 今日曜日だよ → 今=いま   / 日曜日=にちようび / だ / よ
    // No context-free per-token reading map can satisfy both (今日 differs),
    // which is exactly why this needs morphological analysis.
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
