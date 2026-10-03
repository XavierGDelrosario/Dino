import { describe, it, expect } from "vitest";
import { rankCandidates } from "@/services/handwriting/rank";

const cands = (...texts: string[]) => texts.map((text, i) => ({ text, score: 1 - i * 0.1 }));

describe("rankCandidates", () => {
  it("drops punctuation-only candidates", () => {
    const out = rankCandidates(cands("、", "日", "。", "人"));
    expect(out.map((c) => c.text)).toEqual(["日", "人"]);
  });

  it("preserves the original (score) order", () => {
    const out = rankCandidates(cands("ー", "本", "a", "・", "-"));
    // ー (chōonpu) is a letter and stays; ・ and - are dropped.
    expect(out.map((c) => c.text)).toEqual(["ー", "本", "a"]);
  });

  it("treats kanji, kana, latin letters, and digits as content", () => {
    const out = rankCandidates(cands("!", "語", "ね", "Z", "3"));
    expect(out.map((c) => c.text)).toEqual(["語", "ね", "Z", "3"]);
  });

  it("strips punctuation riding on a real candidate, without duplicating it", () => {
    const out = rankCandidates(cands("日。", "日", "「人」"));
    expect(out.map((c) => c.text)).toEqual(["日", "人"]);
    expect(out[0].score).toBe(1); // the better-ranked one is the one kept
  });

  it("is a no-op when nothing is punctuation", () => {
    expect(rankCandidates(cands("学", "校")).map((c) => c.text)).toEqual(["学", "校"]);
  });

  it("handles an empty list", () => {
    expect(rankCandidates([])).toEqual([]);
  });
});
