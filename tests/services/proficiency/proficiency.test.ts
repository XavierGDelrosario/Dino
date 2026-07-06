import { describe, expect, it } from "vitest";
import {
  bandsFromLabels,
  getProficiency,
  labelForBand,
  proficiencyFrameworkFor,
  resolveFramework,
} from "@/services/proficiency";
import type { LangCode } from "@/services/language";
import type { Word } from "@/services/words/repository";

// getProficiency only reads sourceLang + proficiencyBand off the Word, so a minimal
// cast is enough (same pattern as services/domain.ts).
const word = (sourceLang: LangCode, proficiencyBand: number | null): Word =>
  ({ sourceLang, proficiencyBand }) as unknown as Word;

describe("proficiency registry", () => {
  it("routes JA → JLPT and EN → CEFR, others → null", () => {
    expect(resolveFramework("JA")?.code).toBe("JLPT");
    expect(resolveFramework("EN")?.code).toBe("CEFR");
    expect(resolveFramework("KO")).toBeNull();
    expect(resolveFramework("ZH")).toBeNull();
  });

  it("stores bands ascending = harder, regardless of how labels read", () => {
    const jlpt = resolveFramework("JA")!;
    // JLPT labels count DOWN, so value 1 must be the EASIEST (N5) and 5 the hardest (N1).
    expect(jlpt.bands).toHaveLength(5);
    expect(jlpt.bands[0]).toEqual({ value: 1, label: "N5" });
    expect(jlpt.bands[4]).toEqual({ value: 5, label: "N1" });

    const cefr = resolveFramework("EN")!;
    expect(cefr.bands).toHaveLength(6);
    expect(cefr.bands[0]).toEqual({ value: 1, label: "A1" });
    expect(cefr.bands[5]).toEqual({ value: 6, label: "C2" });
  });
});

describe("bandsFromLabels", () => {
  it("assigns value = index + 1 (easiest first)", () => {
    expect(bandsFromLabels(["x", "y", "z"])).toEqual([
      { value: 1, label: "x" },
      { value: 2, label: "y" },
      { value: 3, label: "z" },
    ]);
  });
});

describe("labelForBand", () => {
  const jlpt = resolveFramework("JA")!;
  it("maps a value to its label, null for out-of-range / null", () => {
    expect(labelForBand(jlpt, 3)).toBe("N3");
    expect(labelForBand(jlpt, null)).toBeNull();
    expect(labelForBand(jlpt, 0)).toBeNull();
    expect(labelForBand(jlpt, 99)).toBeNull();
  });
});

describe("getProficiency", () => {
  it("resolves a JA band to a JLPT label", () => {
    expect(getProficiency(word("JA", 3))).toEqual({ framework: "JLPT", band: 3, label: "N3" });
    expect(getProficiency(word("JA", 5))).toEqual({ framework: "JLPT", band: 5, label: "N1" });
  });

  it("resolves an EN band to a CEFR label", () => {
    expect(getProficiency(word("EN", 4))).toEqual({ framework: "CEFR", band: 4, label: "B2" });
  });

  it("is null when the word has no band", () => {
    expect(getProficiency(word("JA", null))).toBeNull();
  });

  it("is null when the language has no framework", () => {
    expect(getProficiency(word("KO", 3))).toBeNull();
  });

  it("is null when the band is out of the framework's range", () => {
    expect(getProficiency(word("JA", 6))).toBeNull(); // JLPT has only 5 bands
  });
});

describe("proficiencyFrameworkFor", () => {
  it("returns the framework for a picker, or null", () => {
    expect(proficiencyFrameworkFor("JA")?.name).toBe("JLPT");
    expect(proficiencyFrameworkFor("KO")).toBeNull();
  });
});
