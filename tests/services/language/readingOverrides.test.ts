import { describe, it, expect } from "vitest";
import {
  applyReadingOverride,
  SINGLE_WORD_READING_OVERRIDES,
} from "@/services/language/readingOverrides";

// Minimal sense shape (only inputReading matters to the reorder).
const sense = (inputReading: string | null, id: string) => ({ inputReading, id });

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

  it("every override reading is hiragana and every surface is a single kanji", () => {
    for (const [surface, reading] of Object.entries(SINGLE_WORD_READING_OVERRIDES)) {
      expect(surface).toMatch(/^[一-鿿]$/);        // one kanji
      expect(reading).toMatch(/^[ぁ-ゖー]+$/);      // hiragana
    }
  });
});
