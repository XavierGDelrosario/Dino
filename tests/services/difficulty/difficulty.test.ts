import { describe, it, expect } from "vitest";
import { getDifficulty } from "@/services/difficulty";
import { makeWord } from "@test/fixtures";

describe("getDifficulty", () => {
  it("bins JMdict frequency rank into 1..5 (lower rank = easier)", () => {
    const at = (frequency: number) => getDifficulty(makeWord({ frequency }));
    expect(at(5)).toEqual({ level: 1, source: "frequency" });
    expect(at(15)).toEqual({ level: 2, source: "frequency" });
    expect(at(25)).toEqual({ level: 3, source: "frequency" });
    expect(at(35)).toEqual({ level: 4, source: "frequency" });
    expect(at(45)).toEqual({ level: 5, source: "frequency" });
    // coarse priority ranks (no nfXX) land in the hardest bin
    expect(at(49)).toEqual({ level: 5, source: "frequency" });
    expect(at(99)).toEqual({ level: 5, source: "frequency" });
  });

  it("returns unknown when there is no signal", () => {
    expect(getDifficulty(makeWord({ frequency: null, difficultyOverride: null }))).toEqual({
      level: null,
      source: "none",
    });
  });

  it("lets a curated override win over frequency", () => {
    // a common word (freq 5 → level 1) curated as hard (override 4) → 4/override
    const w = makeWord({ frequency: 5, difficultyOverride: 4 });
    expect(getDifficulty(w)).toEqual({ level: 4, source: "override" });
  });

  it("uses the override even when there is no frequency", () => {
    expect(getDifficulty(makeWord({ frequency: null, difficultyOverride: 1 }))).toEqual({
      level: 1,
      source: "override",
    });
  });

  it("rates EN→JA words too (default resolver bins the JMdict-scale frequency)", () => {
    const w = makeWord({ sourceLang: "EN", targetLang: "JA", frequency: 5 });
    expect(getDifficulty(w)).toEqual({ level: 1, source: "frequency" });
  });
});
