import { describe, it, expect } from "vitest";
import {
  applyReadingOverride,
  applyWritingOverride,
  SINGLE_WORD_READING_OVERRIDES,
  SINGLE_WORD_WRITING_OVERRIDES,
} from "@/services/language/readingOverrides";

// Minimal sense shape (only inputReading matters to the reorder).
const sense = (inputReading: string | null, id: string) => ({ inputReading, id });
// Writing-override sense shape (only the headword `input` matters).
const wsense = (input: string, id: string) => ({ input, id });

describe("applyReadingOverride", () => {
  it("moves the overridden reading's senses to the front (前 → まえ, not さき)", () => {
    // jmdict tiebreak put the さき entry first; the override must reprioritize まえ.
    const senses = [
      sense("さき", "saki-0"),
      sense("さき", "saki-1"),
      sense("まえ", "mae-0"),
      sense("まえ", "mae-1"),
    ];
    const out = applyReadingOverride("前", senses);
    expect(out.map((s) => s.id)).toEqual(["mae-0", "mae-1", "saki-0", "saki-1"]);
  });

  it("is a no-op when the surface has no override", () => {
    const senses = [sense("あ", "a"), sense("い", "b")];
    expect(applyReadingOverride("猫", senses)).toBe(senses); // same array ref
  });

  it("is a no-op when no sense carries the preferred reading (never invents one)", () => {
    const senses = [sense("ぜん", "z"), sense("さき", "s")]; // まえ absent
    expect(applyReadingOverride("前", senses)).toBe(senses);
  });

  it("is a no-op when every sense already has the preferred reading", () => {
    const senses = [sense("まえ", "m0"), sense("まえ", "m1")];
    expect(applyReadingOverride("前", senses)).toBe(senses);
  });

  it("prefers し over the archaic いち for 市 (city, not market — tied on frequency)", () => {
    // 市 いち (market) and し (city) tie at f=567; the entry-id tiebreak picked いち.
    const senses = [sense("いち", "ichi"), sense("し", "shi")];
    expect(applyReadingOverride("市", senses).map((s) => s.id)).toEqual(["shi", "ichi"]);
  });

  it("keeps the relative order within the matched and non-matched groups (stable)", () => {
    const senses = [
      sense("あれ", "are-0"),
      sense("かれ", "kare-0"),
      sense("あれ", "are-1"),
      sense("かれ", "kare-1"),
    ];
    const out = applyReadingOverride("彼", senses); // 彼 → かれ
    expect(out.map((s) => s.id)).toEqual(["kare-0", "kare-1", "are-0", "are-1"]);
  });

  it("every override reading is hiragana and every surface is written in kanji", () => {
    for (const [surface, reading] of Object.entries(SINGLE_WORD_READING_OVERRIDES)) {
      expect(surface).toMatch(/^[一-鿿]+$/);       // kanji only
      expect(reading).toMatch(/^[ぁ-ゖー]+$/);      // hiragana
    }
  });
});

describe("applyWritingOverride (wrong-word-from-kana)", () => {
  it("moves the overridden writing to the front (もの → 物, not 者)", () => {
    // jmdict ranks 者 (person) first by frequency; the override must prefer 物 (thing).
    const senses = [wsense("者", "sha"), wsense("もの", "nom"), wsense("物", "mono")];
    expect(applyWritingOverride("もの", senses).map((s) => s.id)).toEqual(["mono", "sha", "nom"]);
  });

  it("prefers 所 over the rare yam for ところ (所, not 野老/ところ)", () => {
    // The yam is usually-kana (headword ところ) and borrows the common string's freq.
    const senses = [wsense("ところ", "yam"), wsense("所", "place")];
    expect(applyWritingOverride("ところ", senses).map((s) => s.id)).toEqual(["place", "yam"]);
  });

  it("is a no-op when the surface has no writing override", () => {
    const senses = [wsense("猫", "a"), wsense("ねこ", "b")];
    expect(applyWritingOverride("ねこ", senses)).toBe(senses);
  });

  it("never invents a writing (no-op when the preferred one is absent)", () => {
    const senses = [wsense("者", "sha"), wsense("もの", "nom")]; // 物 absent
    expect(applyWritingOverride("もの", senses)).toBe(senses);
  });

  it("reading and writing override lists don't overlap (a surface is in at most one)", () => {
    const reading = new Set(Object.keys(SINGLE_WORD_READING_OVERRIDES));
    for (const surface of Object.keys(SINGLE_WORD_WRITING_OVERRIDES)) {
      expect(reading.has(surface)).toBe(false);
    }
  });
});

// Quality reports #42 / #43 (2026-10-04), reproduced against the prod dictionary.
describe("quality reports #42–#43", () => {
  it("#43 下手 leads with へた (unskillful), not したて — three entries tied on frequency", () => {
    const senses = [
      sense("したて", "shitate-0"),
      sense("したて", "shitate-1"),
      sense("へた", "heta-0"),
      sense("へた", "heta-1"),
      sense("しもて", "shimote-0"),
    ];
    expect(applyReadingOverride("下手", senses).map((s) => s.id)).toEqual([
      "heta-0", "heta-1", "shitate-0", "shitate-1", "shimote-0",
    ]);
  });

  it("#42 すぎ leads with 過ぎ (past; too much), not the fish that borrows the kana's frequency", () => {
    // 須義 (cobia) is "usually kana", so its HEADWORD is すぎ and it took the kana's frequency.
    const senses = [wsense("すぎ", "cobia"), wsense("過ぎ", "past"), wsense("過ぎ", "too-much"), wsense("杉", "cedar")];
    expect(applyWritingOverride("すぎ", senses).map((s) => s.id)).toEqual(["past", "too-much", "cobia", "cedar"]);
  });
});
