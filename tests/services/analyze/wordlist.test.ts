import { describe, it, expect } from "vitest";
import {
  articleWordList,
  sortWords,
  filterByStatus,
  coverageOf,
  wordsToTarget,
  type ArticleWord,
} from "@/services/analyze/wordlist";
import type { AnalyzedToken } from "@/services/language";
import { makeWord } from "@test/fixtures";

const tok = (text: string, pos = "名詞"): AnalyzedToken => ({
  text,
  start: 0,
  end: text.length,
  reading: null,
  lemma: null,
  pos,
});

describe("articleWordList", () => {
  it("keeps unique REGISTERED words, dropping no-entry + grammatical, and COUNTS occurrences", () => {
    const tokens = [
      tok("猫"),
      tok("犬"),
      tok("走る"), // no dictionary entry → dropped
      tok("猫"), // second occurrence of 猫 → tallied, not a new row
      tok("は", "助詞"), // grammatical → dropped
    ];
    const meaningsByWord = new Map([
      ["猫", [makeWord({ wordId: "neko", input: "猫" })]],
      ["犬", [makeWord({ wordId: "inu", input: "犬" })]],
    ]);
    const rows = articleWordList({
      tokens,
      meaningsByWord,
      saved: new Set(["neko"]),
      confidence: new Map([["neko", 4]]),
    });

    expect(rows.map((r) => r.headword)).toEqual(["猫", "犬"]);
    expect(rows[0]).toMatchObject({ status: "known", confidence: 4, occurrences: 2 });
    expect(rows[1]).toMatchObject({ status: "new", confidence: 0, occurrences: 1 });
  });

  it("dedupes conjugations into one row and sums their occurrences", () => {
    const tokens = [tok("行っ"), tok("行き"), tok("辛い")];
    const iku = makeWord({ wordId: "iku", input: "行く" });
    const rows = articleWordList({
      tokens,
      meaningsByWord: new Map([
        ["行っ", [iku]],
        ["行き", [iku]], // same primary → collapses, occurrences += 1
        ["辛い", [makeWord({ wordId: "karai", input: "辛い" })]],
      ]),
      saved: new Set(),
      confidence: new Map(),
    });
    expect(rows.map((r) => r.headword)).toEqual(["行く", "辛い"]);
    expect(rows[0].occurrences).toBe(2);
    expect(rows[1].occurrences).toBe(1);
  });
});

const w = (
  id: string,
  freq: number | null,
  status: "new" | "known",
  conf = 0,
  occ = 1,
  diff: number | null = null,
): ArticleWord => ({
  headword: id,
  reading: id,
  primary: makeWord({ wordId: id }),
  senses: [makeWord({ wordId: id })],
  frequency: freq,
  level: null,
  difficulty: diff,
  occurrences: occ,
  status,
  confidence: conf,
});

describe("sortWords", () => {
  it("recommended puts least-known first — a frequent BUT confident word is not on top", () => {
    const rows = [
      w("knownFreq", 600, "known", 5, 9), // frequent + fully confident → should sink
      w("newRare", 100, "new", 0, 1),
      w("newFreq", 300, "new", 0, 5),
    ];
    expect(sortWords(rows, "recommended").map((r) => r.headword)).toEqual([
      "newFreq",
      "newRare",
      "knownFreq",
    ]);
  });

  it("occurrences axis flips least ⇄ most", () => {
    const rows = [w("a", 500, "new", 0, 1), w("b", 500, "new", 0, 3), w("c", 500, "new", 0, 2)];
    expect(sortWords(rows, "occurrences", "least").map((r) => r.headword)).toEqual(["a", "c", "b"]);
    expect(sortWords(rows, "occurrences", "most").map((r) => r.headword)).toEqual(["b", "c", "a"]);
  });

  it("common axis: least = rarest first, most = commonest first", () => {
    const rows = [w("rare", 200, "new"), w("common", 600, "new"), w("mid", 400, "new")];
    expect(sortWords(rows, "common", "least").map((r) => r.headword)).toEqual(["rare", "mid", "common"]);
    expect(sortWords(rows, "common", "most").map((r) => r.headword)).toEqual(["common", "mid", "rare"]);
  });

  it("confident axis: least = least known first", () => {
    const rows = [w("hi", 500, "known", 5), w("lo", 500, "known", 1), w("fresh", 500, "new", 0)];
    expect(sortWords(rows, "confident", "least").map((r) => r.headword)).toEqual(["fresh", "lo", "hi"]);
  });

  it("difficult axis keeps unrated (null) last in BOTH directions", () => {
    const rows = [w("hard", 500, "new", 0, 1, 3), w("easy", 500, "new", 0, 1, 1), w("unrated", 500, "new", 0, 1, null)];
    expect(sortWords(rows, "difficult", "least").map((r) => r.headword)).toEqual(["easy", "hard", "unrated"]);
    expect(sortWords(rows, "difficult", "most").map((r) => r.headword)).toEqual(["hard", "easy", "unrated"]);
  });

  it("does not mutate the input array", () => {
    const rows = [w("rare", 200, "new"), w("common", 600, "new")];
    const before = rows.map((r) => r.headword);
    sortWords(rows, "common", "most");
    expect(rows.map((r) => r.headword)).toEqual(before);
  });
});

describe("coverage + target", () => {
  const rows = [
    w("a", 500, "known"),
    w("b", 500, "known"),
    w("c", 500, "new"),
    w("d", 500, "new"),
  ];

  it("computes known / total / pct", () => {
    expect(coverageOf(rows)).toEqual({ known: 2, total: 4, pct: 0.5 });
  });

  it("wordsToTarget = new words needed to reach the threshold", () => {
    // 4 words, 2 known (50%). 95% of 4 = ceil(3.8) = 4 known needed → learn 2.
    expect(wordsToTarget(rows, 0.95)).toBe(2);
    // Already at/above target → 0.
    expect(wordsToTarget([w("x", 1, "known")], 0.95)).toBe(0);
    // No words → 0.
    expect(wordsToTarget([], 0.95)).toBe(0);
  });

  it("filterByStatus narrows to new / known", () => {
    expect(filterByStatus(rows, "new").map((r) => r.headword)).toEqual(["c", "d"]);
    expect(filterByStatus(rows, "known")).toHaveLength(2);
    expect(filterByStatus(rows, "all")).toHaveLength(4);
  });
});
