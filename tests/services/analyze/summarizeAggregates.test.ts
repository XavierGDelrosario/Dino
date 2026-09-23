// summarizeAggregates — the lists index builds its charts from SQL counts, never words.
//
// The load-bearing bit is the FREQUENCY MAPPING, and it is easy to get backwards.
// FREQ_BINS is declared common→rare (550, 450, 350, 250, -inf), but SQL's width_bucket
// needs thresholds ASCENDING, so the client sends [250,350,450,550] and gets back bucket
// indices that run the OTHER way: 0 is below every threshold (the rarest), 4 is above
// them all (the commonest). Invert that by one step and every list's chart is a mirror
// of the truth while still looking perfectly plausible — no crash, no empty bar, just
// wrong. Hence these assertions name the label they expect, not the index.
import { describe, it, expect } from "vitest";
import {
  summarizeAggregates,
  FREQ_BIN_THRESHOLDS_ASC,
} from "@/services/analyze/summarize";

const base = { total: 0, confidence: [0, 0, 0, 0, 0, 0], freq: {}, band: {}, mainLang: null };
const bar = (d: ReturnType<typeof summarizeAggregates>, title: string) =>
  d.bars.find((b) => b.title === title);
const valueOf = (d: ReturnType<typeof summarizeAggregates>, title: string, label: string) =>
  bar(d, title)?.buckets.find((b) => b.label === label)?.value;

describe("summarizeAggregates — frequency buckets", () => {
  it("sends the thresholds ASCENDING, as width_bucket requires", () => {
    expect(FREQ_BIN_THRESHOLDS_ASC).toEqual([250, 350, 450, 550]);
  });

  it("maps bucket 4 (above every threshold) to the COMMONEST bin", () => {
    const d = summarizeAggregates({ ...base, total: 7, freq: { "4": 7 } });
    expect(valueOf(d, "Frequency", "Very common")).toBe(7);
    expect(valueOf(d, "Frequency", "Rare")).toBe(0);
  });

  it("maps bucket 0 (below every threshold) to the RAREST bin", () => {
    const d = summarizeAggregates({ ...base, total: 5, freq: { "0": 5 } });
    expect(valueOf(d, "Frequency", "Rare")).toBe(5);
    expect(valueOf(d, "Frequency", "Very common")).toBe(0);
  });

  it("walks the whole scale in order", () => {
    const d = summarizeAggregates({
      ...base,
      total: 15,
      freq: { "0": 1, "1": 2, "2": 3, "3": 4, "4": 5 },
    });
    expect(valueOf(d, "Frequency", "Rare")).toBe(1);
    expect(valueOf(d, "Frequency", "Uncommon")).toBe(2);
    expect(valueOf(d, "Frequency", "Mid")).toBe(3);
    expect(valueOf(d, "Frequency", "Common")).toBe(4);
    expect(valueOf(d, "Frequency", "Very common")).toBe(5);
  });

  it("puts -1 in the unranked bucket, not in a real bin", () => {
    const d = summarizeAggregates({ ...base, total: 9, freq: { "-1": 9 } });
    expect(valueOf(d, "Frequency", "—")).toBe(9);
    expect(bar(d, "Frequency")!.buckets.filter((b) => b.label !== "—").every((b) => b.value === 0))
      .toBe(true);
  });

  it("keeps a bucket the current bins no longer cover, as unranked", () => {
    // A re-tuned FREQ_BINS would otherwise silently DROP counts, so the bar's total
    // would stop matching the word count printed beside it.
    const d = summarizeAggregates({ ...base, total: 4, freq: { "99": 4 } });
    const total = bar(d, "Frequency")!.buckets.reduce((s, b) => s + b.value, 0);
    expect(total).toBe(4);
    expect(valueOf(d, "Frequency", "—")).toBe(4);
  });
});

describe("summarizeAggregates — difficulty bands", () => {
  it("labels raw band ordinals through the language's framework", () => {
    const d = summarizeAggregates({
      ...base,
      total: 6,
      band: { "1": 2, "2": 4 },
      mainLang: "JA",
    });
    // JLPT ascends easiest→hardest, so ordinal 1 is N5.
    expect(valueOf(d, "Difficulty", "N5")).toBe(2);
    expect(valueOf(d, "Difficulty", "N4")).toBe(4);
  });

  it("drops the Difficulty bar entirely when nothing carries a band", () => {
    const d = summarizeAggregates({ ...base, total: 3, band: { "-1": 3 }, mainLang: "JA" });
    expect(bar(d, "Difficulty")).toBeUndefined();
  });

  it("drops it for a language with no framework, however many bands arrive", () => {
    const d = summarizeAggregates({ ...base, total: 3, band: { "1": 3 }, mainLang: "KO" });
    expect(bar(d, "Difficulty")).toBeUndefined();
  });
});

describe("summarizeAggregates — confidence", () => {
  it("passes the six buckets straight through, in order", () => {
    const d = summarizeAggregates({ ...base, total: 21, confidence: [1, 2, 3, 4, 5, 6] });
    expect(bar(d, "Confidence")!.buckets.map((b) => b.value)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("reports the caller's total, so the chart's denominator is the word count", () => {
    expect(summarizeAggregates({ ...base, total: 42 }).total).toBe(42);
  });
});
