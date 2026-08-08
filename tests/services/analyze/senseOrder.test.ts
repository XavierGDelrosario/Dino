import { describe, expect, it } from "vitest";
import { orderSensesByContextReading } from "@/services/analyze/senseOrder";

/** Minimal shape — the helper only ever reads `inputReading`. */
const sense = (id: string, inputReading: string | null) => ({ id, inputReading });

const ids = (list: { id: string }[]) => list.map((s) => s.id);

// 辛い: からい "spicy" vs つらい "painful" — the case the feature exists for.
const KARAI = sense("karai", "からい");
const TSURAI = sense("tsurai", "つらい");

describe("orderSensesByContextReading", () => {
  it("leads with the sense the context reading picked", () => {
    expect(ids(orderSensesByContextReading([KARAI, TSURAI], "つらい"))).toEqual(["tsurai", "karai"]);
  });

  it("leaves the order alone when the context already agrees", () => {
    expect(ids(orderSensesByContextReading([KARAI, TSURAI], "からい"))).toEqual(["karai", "tsurai"]);
  });

  it("keeps relative order within each group", () => {
    const list = [sense("a", "あ"), sense("b", "い"), sense("c", "あ"), sense("d", "い")];
    expect(ids(orderSensesByContextReading(list, "い"))).toEqual(["b", "d", "a", "c"]);
  });

  it("matches across scripts — a katakana headword vs a hiragana token reading", () => {
    // kuromoji folds its readings to hiragana; a JMdict kana headword keeps katakana.
    // Without the fold every katakana word would silently fail to match.
    const list = [sense("other", "たま"), sense("coffee", "コーヒー")];
    expect(ids(orderSensesByContextReading(list, "こーひー"))).toEqual(["coffee", "other"]);
  });

  it("is a REORDER — it never drops a sense", () => {
    const list = [KARAI, TSURAI, sense("third", "からい")];
    const out = orderSensesByContextReading(list, "つらい");
    expect(out).toHaveLength(3);
    expect(new Set(ids(out))).toEqual(new Set(["karai", "tsurai", "third"]));
  });

  describe("declines to act rather than guess", () => {
    it("no context reading → unchanged", () => {
      const list = [KARAI, TSURAI];
      expect(orderSensesByContextReading(list, null)).toBe(list);
      expect(orderSensesByContextReading(list, undefined)).toBe(list);
      expect(orderSensesByContextReading(list, "  ")).toBe(list);
    });

    it("a single sense → nothing to disambiguate", () => {
      const list = [KARAI];
      expect(orderSensesByContextReading(list, "つらい")).toBe(list);
    });

    it("no sense matches → the dictionary's ranking stands", () => {
      const list = [KARAI, TSURAI];
      expect(orderSensesByContextReading(list, "ぜんぜんちがう")).toBe(list);
    });

    it("EVERY sense matches → the reading doesn't separate them", () => {
      // 辛い's two つらい senses: reordering would churn without informing.
      const list = [sense("a", "つらい"), sense("b", "つらい")];
      expect(orderSensesByContextReading(list, "つらい")).toBe(list);
    });

    it("senses with no reading of their own are never promoted", () => {
      const list = [sense("noreading", null), TSURAI];
      expect(ids(orderSensesByContextReading(list, "つらい"))).toEqual(["tsurai", "noreading"]);
    });

    it("an empty list is returned as-is", () => {
      const list: { id: string; inputReading: string | null }[] = [];
      expect(orderSensesByContextReading(list, "つらい")).toBe(list);
    });
  });

  it("does not mutate the input", () => {
    const list = [KARAI, TSURAI];
    const before = ids(list);
    orderSensesByContextReading(list, "つらい");
    expect(ids(list)).toEqual(before);
  });
});
