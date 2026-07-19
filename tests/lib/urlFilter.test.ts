import { describe, it, expect } from "vitest";
import { chunkForUrlFilter, URL_FILTER_BUDGET_BYTES } from "@/lib/urlFilter";
import {
  chunkForUrlFilter as edgeChunk,
  URL_FILTER_BUDGET_BYTES as EDGE_BUDGET,
} from "../../supabase/functions/translate/_lib";

// The encoded size of one chunk's values, the thing that actually has to stay
// bounded (`repeats` copies of the list end up in one URL).
const encodedSize = (chunk: string[], repeats = 1) =>
  chunk.reduce((n, v) => n + encodeURIComponent(v).length + 4, 0) * repeats;

// A realistic Japanese key set: this is the shape that broke prod — 161 unique
// terms from a 712-char paste, each ~9 encoded bytes per character.
const japaneseKeys = (n: number) =>
  Array.from({ length: n }, (_, i) => `漢字${i}`);

describe("chunkForUrlFilter", () => {
  it("keeps every chunk within the byte budget", () => {
    for (const chunk of chunkForUrlFilter(japaneseKeys(161))) {
      expect(encodedSize(chunk)).toBeLessThanOrEqual(URL_FILTER_BUDGET_BYTES);
    }
  });

  it("halves the budget when the list appears twice in one URL", () => {
    // The words cache read matches input AND input_reading — miss this and the
    // fix silently under-chunks by 2x.
    for (const chunk of chunkForUrlFilter(japaneseKeys(161), { repeats: 2 })) {
      expect(encodedSize(chunk, 2)).toBeLessThanOrEqual(URL_FILTER_BUDGET_BYTES);
    }
  });

  it("loses nothing and preserves order", () => {
    const values = japaneseKeys(161);
    expect(chunkForUrlFilter(values).flat()).toEqual(values);
  });

  it("actually splits the paste that broke prod (a single chunk would not have)", () => {
    expect(chunkForUrlFilter(japaneseKeys(161), { repeats: 2 }).length).toBeGreaterThan(1);
  });

  it("budgets by ENCODED bytes, not item count — Japanese chunks smaller than ASCII", () => {
    const ja = chunkForUrlFilter(japaneseKeys(200));
    const en = chunkForUrlFilter(Array.from({ length: 200 }, (_, i) => `word${i}`));
    expect(ja[0].length).toBeLessThan(en[0].length);
  });

  it("does not drop a single value larger than the whole budget", () => {
    const huge = "漢".repeat(2000);
    expect(chunkForUrlFilter([huge, "猫"]).flat()).toEqual([huge, "猫"]);
  });

  it("returns nothing for an empty list", () => {
    expect(chunkForUrlFilter([])).toEqual([]);
  });

  it("edge and client copies agree (hand-mirrored across runtimes)", () => {
    expect(EDGE_BUDGET).toBe(URL_FILTER_BUDGET_BYTES);
    for (const opts of [{}, { repeats: 2 }, { budgetBytes: 500 }]) {
      expect(edgeChunk(japaneseKeys(161), opts)).toEqual(chunkForUrlFilter(japaneseKeys(161), opts));
    }
  });
});
