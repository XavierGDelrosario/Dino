import { describe, it, expect, beforeEach } from "vitest";
import { makeWord } from "@test/fixtures";
import {
  getCachedSenses,
  setCachedSenses,
  isKnownDictionaryMiss,
  markDictionaryMiss,
  __clearWordsCache,
} from "@/services/words/cache";

beforeEach(() => __clearWordsCache());

describe("sense memo", () => {
  it("round-trips senses for a lookup", () => {
    const cat = [makeWord()];
    setCachedSenses("猫", "JA", "EN", cat);
    expect(getCachedSenses("猫", "JA", "EN")).toEqual(cat);
  });

  it("distinguishes 'not memoized' from 'no senses' — an empty list is NOT stored", () => {
    setCachedSenses("猫", "JA", "EN", []);
    // undefined means "ask the edge, which may still populate it" — the whole
    // reason normal negatives aren't cached.
    expect(getCachedSenses("猫", "JA", "EN")).toBeUndefined();
  });

  it("keys on the language pair, not just the term", () => {
    setCachedSenses("愛", "JA", "EN", [makeWord({ input: "愛" })]);
    expect(getCachedSenses("愛", "ZH", "EN")).toBeUndefined();
  });

  it("normalizes the key so composed/decomposed Japanese can't fork it", () => {
    setCachedSenses("がっこう".normalize("NFD"), "JA", "EN", [makeWord()]);
    expect(getCachedSenses("がっこう".normalize("NFC"), "JA", "EN")).toBeDefined();
  });
});

describe("dictionary misses (probe-only negative cache)", () => {
  it("remembers that the dictionary has no entry for a term", () => {
    expect(isKnownDictionaryMiss("漢方製剤", "JA", "EN")).toBe(false);
    markDictionaryMiss("漢方製剤", "JA", "EN");
    expect(isKnownDictionaryMiss("漢方製剤", "JA", "EN")).toBe(true);
  });

  it("keys on the language pair", () => {
    markDictionaryMiss("漢方製剤", "JA", "EN");
    expect(isKnownDictionaryMiss("漢方製剤", "JA", "ZH")).toBe(false);
  });

  it("is a SEPARATE store — misses never evict real cached senses", () => {
    const cat = [makeWord()];
    setCachedSenses("猫", "JA", "EN", cat);
    // Far more misses than the sense cap, as a noun-dense paste would produce.
    for (let i = 0; i < 3000; i++) markDictionaryMiss(`偽語${i}`, "JA", "EN");
    expect(getCachedSenses("猫", "JA", "EN")).toEqual(cat);
  });

  it("bounds itself so a long session can't grow it without limit", () => {
    for (let i = 0; i < 5000; i++) markDictionaryMiss(`偽語${i}`, "JA", "EN");
    // Oldest evicted first; the most recent are still remembered.
    expect(isKnownDictionaryMiss("偽語0", "JA", "EN")).toBe(false);
    expect(isKnownDictionaryMiss("偽語4999", "JA", "EN")).toBe(true);
  });

  it("a miss does not make the term look cached (the two stores are independent)", () => {
    markDictionaryMiss("漢方製剤", "JA", "EN");
    expect(getCachedSenses("漢方製剤", "JA", "EN")).toBeUndefined();
  });

  it("clears with the rest of the cache", () => {
    markDictionaryMiss("漢方製剤", "JA", "EN");
    __clearWordsCache();
    expect(isKnownDictionaryMiss("漢方製剤", "JA", "EN")).toBe(false);
  });
});
