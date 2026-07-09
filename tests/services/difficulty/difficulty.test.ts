import { describe, it, expect } from "vitest";
import { getDifficulty, frequencyCommonness } from "@/services/difficulty";
import { makeWord } from "@test/fixtures";

describe("frequencyCommonness (frequency axis alone, ignoring override/proficiency)", () => {
  const at = (frequency: number | null) => frequencyCommonness({ sourceLang: "JA", frequency });

  it("maps the Zipf ×100 score to a 1..5 commonness band (1 = most common)", () => {
    expect(at(552)).toBe(1); // 行く — very common
    expect(at(505)).toBe(1); // 猫
    expect(at(470)).toBe(2);
    expect(at(420)).toBe(3);
    expect(at(350)).toBe(4);
    expect(at(256)).toBe(5); // rare
  });

  it("is null when the word has no frequency", () => {
    expect(at(null)).toBeNull();
  });

  it("ignores a curated proficiency band (commonness is the frequency axis only)", () => {
    // A hard-but-common word (band set, high frequency) is still 'very common' here,
    // even though getDifficulty would return the curated level.
    expect(frequencyCommonness({ sourceLang: "JA", frequency: 552 })).toBe(1);
  });
});

describe("getDifficulty", () => {
  it("bins the wordfreq Zipf score (×100) into 1..5 (higher score = easier)", () => {
    const at = (frequency: number) => getDifficulty(makeWord({ frequency }));
    expect(at(552)).toEqual({ level: 1, source: "frequency" }); // 行く, very common
    expect(at(505)).toEqual({ level: 1, source: "frequency" }); // 猫
    expect(at(470)).toEqual({ level: 2, source: "frequency" });
    expect(at(420)).toEqual({ level: 3, source: "frequency" });
    expect(at(350)).toEqual({ level: 4, source: "frequency" });
    expect(at(256)).toEqual({ level: 5, source: "frequency" }); // 形而上学, rare/hard
  });

  it("returns unknown when there is no signal", () => {
    expect(getDifficulty(makeWord({ frequency: null, difficultyOverride: null }))).toEqual({
      level: null,
      source: "none",
    });
  });

  it("lets a curated override win over frequency", () => {
    // a common word (Zipf 552 → level 1) curated as hard (override 4) → 4/override
    const w = makeWord({ frequency: 552, difficultyOverride: 4 });
    expect(getDifficulty(w)).toEqual({ level: 4, source: "override" });
  });

  it("uses the override even when there is no frequency", () => {
    expect(getDifficulty(makeWord({ frequency: null, difficultyOverride: 1 }))).toEqual({
      level: 1,
      source: "override",
    });
  });

  it("rates EN→JA words too (the Zipf scale is language-neutral)", () => {
    const w = makeWord({ sourceLang: "EN", targetLang: "JA", frequency: 505 });
    expect(getDifficulty(w)).toEqual({ level: 1, source: "frequency" });
  });

  // ── curated proficiency LEVEL beats frequency (common ≠ beginner) ──────────
  it("prefers the curated JLPT band over frequency, even for a COMMON word", () => {
    // 的-style: very common (Zipf 552 → freq level 1) but curated N3 (band 3) →
    // difficulty follows the LEVEL, not the commonness.
    const w = makeWord({ sourceLang: "JA", frequency: 552, proficiencyBand: 3 });
    expect(getDifficulty(w)).toEqual({ level: 3, source: "proficiency" });
  });

  it("maps JLPT bands 1:1 to difficulty (5 bands → identity)", () => {
    const at = (band: number) =>
      getDifficulty(makeWord({ sourceLang: "JA", frequency: 552, proficiencyBand: band })).level;
    expect([1, 2, 3, 4, 5].map(at)).toEqual([1, 2, 3, 4, 5]);
  });

  it("normalizes CEFR's 6 bands onto the 1..5 scale (A1→1 … C2→5)", () => {
    const at = (band: number) =>
      getDifficulty(makeWord({ sourceLang: "EN", targetLang: "JA", frequency: 552, proficiencyBand: band })).level;
    // A1,A2,B1,B2,C1,C2 → 1,2,3,3,4,5
    expect([1, 2, 3, 4, 5, 6].map(at)).toEqual([1, 2, 3, 3, 4, 5]);
  });

  it("lets an explicit override outrank even the proficiency band", () => {
    const w = makeWord({ sourceLang: "JA", frequency: 552, proficiencyBand: 5, difficultyOverride: 2 });
    expect(getDifficulty(w)).toEqual({ level: 2, source: "override" });
  });

  it("falls back to frequency when a band is out of the framework's range", () => {
    // JLPT has 5 bands; band 6 is invalid → ignore it, use frequency.
    const w = makeWord({ sourceLang: "JA", frequency: 420, proficiencyBand: 6 });
    expect(getDifficulty(w)).toEqual({ level: 3, source: "frequency" });
  });

  it("falls back to frequency when the language has no proficiency framework", () => {
    // KO has no framework in the registry → the band can't be interpreted → frequency.
    const w = makeWord({ sourceLang: "KO", targetLang: "EN", frequency: 505, proficiencyBand: 2 });
    expect(getDifficulty(w)).toEqual({ level: 1, source: "frequency" });
  });
});
