import { describe, it, expect } from "vitest";
import { getDifficulty } from "@/services/difficulty";
import { makeWord } from "@test/fixtures";

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
});
