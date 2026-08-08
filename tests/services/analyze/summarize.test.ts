import { describe, it, expect } from "vitest";
import { summarizeReader, summarizeUserWords } from "@/services/analyze/summarize";
import type { AnalyzedToken } from "@/services/language";
import { makeUserWord, makeWord } from "@test/fixtures";
import type { UserWord } from "@/services/words/userWords";

// Minimal content token (名詞 = noun); 助詞 = particle is grammatical (ignored).
const tok = (text: string, pos = "名詞"): AnalyzedToken => ({
  text,
  start: 0,
  end: text.length,
  reading: null,
  lemma: null,
  pos,
});

describe("summarizeReader", () => {
  it("counts UNIQUE content words and splits coverage (known / new / no-entry)", () => {
    const tokens = [
      tok("猫"), // known
      tok("犬"), // in dict, not saved → new
      tok("走る"), // no dictionary entry
      tok("猫"), // duplicate → not recounted
      tok("は", "助詞"), // grammatical → excluded
    ];
    const meaningsByWord = new Map([
      ["猫", [makeWord({ wordId: "neko", input: "猫" })]],
      ["犬", [makeWord({ wordId: "inu", input: "犬" })]],
    ]);
    const { total, data } = summarizeReader({
      tokens,
      meaningsByWord,
      saved: new Set(["neko"]),
      confidence: new Map([["neko", 4]]),
    });

    expect(total).toBe(3); // 猫, 犬, 走る (dup + particle excluded; 走る still counts toward total)
    // Pie: Known vs New only — no-entry (走る) is excluded from the pie.
    const pie = Object.fromEntries(data.pie!.buckets.map((b) => [b.key, b.value]));
    expect(pie).toEqual({ known: 1, new: 1 });
    // Confidence chart leads with a "New" row (blue) = the fresh/addable words.
    const conf = data.bars.find((s) => s.title === "Confidence")!;
    expect(conf.buckets[0]).toMatchObject({ key: "new", value: 1 });
  });

  it("bins confidence 0..5 for known words, taking the max over saved senses", () => {
    // Keys are wordKey(token) — lowercased — so the fixture uses that form.
    const tokens = [tok("A"), tok("B"), tok("C")];
    const meaningsByWord = new Map([
      ["a", [makeWord({ wordId: "a" })]],
      ["b", [makeWord({ wordId: "b" })]],
      ["c", [makeWord({ wordId: "c1" }), makeWord({ wordId: "c2" })]],
    ]);
    const { data } = summarizeReader({
      tokens,
      meaningsByWord,
      saved: new Set(["a", "b", "c1", "c2"]),
      confidence: new Map([
        ["a", 5],
        ["b", 5],
        ["c1", 2],
        ["c2", 4],
      ]),
    });
    const conf = data.bars.find((s) => s.title === "Confidence")!;
    const byKey = Object.fromEntries(conf.buckets.map((b) => [b.key, b.value]));
    expect(byKey["5"]).toBe(2); // A, B
    expect(byKey["4"]).toBe(1); // C = max(2, 4)
    expect(byKey["2"]).toBe(0);
  });

  it("bins frequency (Zipf ×100), marks unranked as —, and counts known per bin", () => {
    const tokens = [tok("hi"), tok("hi2"), tok("mid"), tok("na")];
    const meaningsByWord = new Map([
      ["hi", [makeWord({ wordId: "h", frequency: 600 })]], // very common, known
      ["hi2", [makeWord({ wordId: "h2", frequency: 590 })]], // very common, not known
      ["mid", [makeWord({ wordId: "m", frequency: 380 })]], // mid
      ["na", [makeWord({ wordId: "n", frequency: null })]], // —
    ]);
    const { data } = summarizeReader({
      tokens,
      meaningsByWord,
      saved: new Set(["h"]), // only "hi" is known
      confidence: new Map([["h", 3]]),
    });
    const freq = data.bars.find((s) => s.title === "Frequency")!;
    const byKey = Object.fromEntries(freq.buckets.map((b) => [b.key, b]));
    expect(byKey.vcommon.value).toBe(2);
    expect(byKey.vcommon.known).toBe(1); // 1 of 2 very-common words is known
    expect(byKey.mid.value).toBe(1);
    expect(byKey.mid.known).toBe(0);
    expect(byKey["—"].value).toBe(1);
  });

  it('labels JLPT levels under "Difficulty" (hardest-first) and — for a word with no band', () => {
    const tokens = [tok("n5"), tok("n1"), tok("nb")];
    const meaningsByWord = new Map([
      ["n5", [makeWord({ wordId: "a", proficiencyBand: 1 })]], // N5
      ["n1", [makeWord({ wordId: "b", proficiencyBand: 5 })]], // N1
      ["nb", [makeWord({ wordId: "c", proficiencyBand: null })]],
    ]);
    const { data } = summarizeReader({
      tokens,
      meaningsByWord,
      saved: new Set(),
      confidence: new Map(),
    });
    const difficulty = data.bars.find((s) => s.title === "Difficulty")!;
    const byKey = Object.fromEntries(difficulty.buckets.map((b) => [b.key, b.value]));
    expect(byKey.N5).toBe(1);
    expect(byKey.N1).toBe(1);
    expect(byKey["—"]).toBe(1);
    const order = difficulty.buckets.map((b) => b.key);
    expect(order.indexOf("N1")).toBeLessThan(order.indexOf("N5")); // hardest first
  });

  it("hides the Difficulty series entirely when no word carries a band", () => {
    const tokens = [tok("a"), tok("b")];
    const meaningsByWord = new Map([
      ["a", [makeWord({ wordId: "a", proficiencyBand: null })]],
      ["b", [makeWord({ wordId: "b", proficiencyBand: null })]],
    ]);
    const { data } = summarizeReader({
      tokens,
      meaningsByWord,
      saved: new Set(),
      confidence: new Map(),
    });
    expect(data.bars.some((s) => s.title === "Difficulty")).toBe(false);
    // Confidence + Frequency still render, in that order
    expect(data.bars.map((s) => s.title)).toEqual(["Confidence", "Frequency"]);
  });
});

describe("summarizeUserWords (a saved list)", () => {
  const uw = (o: Partial<UserWord> = {}): UserWord =>
    makeUserWord({ sourceLang: "JA", targetLang: "EN", ...o });

  it("omits the coverage pie — a saved list is 100% known, so the split says nothing", () => {
    const { total, data } = summarizeUserWords([uw({ confidenceRating: 3 }), uw({ confidenceRating: 5 })]);
    expect(data.pie).toBeUndefined();
    expect(total).toBe(2);
  });

  it("buckets live confidence 0..5 with NO 'New' row", () => {
    const { data } = summarizeUserWords([
      uw({ confidenceRating: 0 }),
      uw({ confidenceRating: 4 }),
      uw({ confidenceRating: 4 }),
    ]);
    const conf = data.bars.find((b) => b.title === "Confidence")!;
    expect(conf.buckets.map((b) => b.key)).toEqual(["0", "1", "2", "3", "4", "5"]); // no "new"
    expect(conf.buckets.find((b) => b.key === "4")!.value).toBe(2);
    expect(conf.buckets.find((b) => b.key === "0")!.value).toBe(1);
  });

  it("reports no knowledge split on the ordinal bars (nothing to overlay)", () => {
    const { data } = summarizeUserWords([uw({ frequency: 600 }), uw({ frequency: null })]);
    const freq = data.bars.find((b) => b.title === "Frequency")!;
    expect(freq.buckets.every((b) => b.known === undefined)).toBe(true);
    expect(freq.buckets.find((b) => b.key === "vcommon")!.value).toBe(1);
    expect(freq.buckets.find((b) => b.key === "—")!.value).toBe(1); // unranked
  });

  it("builds Difficulty for the DOMINANT language only — JLPT and CEFR are different rulers", () => {
    const { data } = summarizeUserWords([
      uw({ sourceLang: "JA", proficiencyBand: 1 }), // band 1 = N5 (easiest)
      uw({ sourceLang: "JA", proficiencyBand: 1 }),
      uw({ sourceLang: "EN", proficiencyBand: 1 }), // minority language — not on this axis
    ]);
    const level = data.bars.find((b) => b.title === "Difficulty")!;
    const counted = level.buckets.reduce((n, b) => n + b.value, 0);
    expect(counted).toBe(2); // only the two JA words
    expect(level.buckets.some((b) => b.label === "N5" && b.value === 2)).toBe(true);
  });

  it("hides Difficulty when no word carries a band", () => {
    const { data } = summarizeUserWords([uw({ proficiencyBand: null })]);
    expect(data.bars.some((b) => b.title === "Difficulty")).toBe(false);
  });
});
