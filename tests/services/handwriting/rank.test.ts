import { describe, it, expect } from "vitest";
import { rankCandidates } from "@/services/handwriting/rank";

const cands = (...texts: string[]) => texts.map((text, i) => ({ text, score: 1 - i * 0.1 }));

describe("rankCandidates", () => {
  it("pushes punctuation-only candidates to the end", () => {
    const out = rankCandidates(cands("、", "日", "。", "人"));
    expect(out.map((c) => c.text)).toEqual(["日", "人", "、", "。"]);
  });

  it("preserves the original (score) order within each group", () => {
    const out = rankCandidates(cands("ー", "本", "a", "・", "-"));
    // ー (chōonpu, a letter), 本, a stay in order; ・ and - sink in order.
    expect(out.map((c) => c.text)).toEqual(["ー", "本", "a", "・", "-"]);
  });

  it("treats kanji, kana, latin letters, and digits as content", () => {
    const out = rankCandidates(cands("!", "語", "ね", "Z", "3"));
    expect(out.map((c) => c.text)).toEqual(["語", "ね", "Z", "3", "!"]);
  });

  it("is a no-op when nothing is punctuation", () => {
    expect(rankCandidates(cands("学", "校")).map((c) => c.text)).toEqual(["学", "校"]);
  });

  it("handles an empty list", () => {
    expect(rankCandidates([])).toEqual([]);
  });
});
