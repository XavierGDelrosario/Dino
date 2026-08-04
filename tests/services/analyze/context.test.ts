import { describe, it, expect } from "vitest";
import { contextByWord, highlightSegments } from "@/services/analyze/context";
import { splitSentences } from "@/services/language";
import type { AnalyzedToken } from "@/services/language";
import type { Word } from "@/services/words/repository";
import { makeWord } from "@test/fixtures";

/** Build tokens by locating each surface in `text`, so offsets are real. */
function tokensIn(text: string, surfaces: { text: string; pos?: string; nth?: number }[]): AnalyzedToken[] {
  return surfaces.map(({ text: s, pos = "名詞", nth = 0 }) => {
    let start = -1;
    for (let i = 0; i <= nth; i++) start = text.indexOf(s, start + 1);
    return { text: s, start, end: start + s.length, reading: null, lemma: null, pos };
  });
}

const sentencesOf = (text: string, gloss: string | null = null) =>
  splitSentences(text).map((s) => ({ ...s, gloss }));

const meanings = (entries: [string, Word][]) => new Map(entries.map(([k, w]) => [k, [w]]));

describe("contextByWord", () => {
  const text = "猫が好きです。犬も好きです。";

  it("maps each word to the sentence it appeared in, keyed by the PRIMARY sense id", () => {
    const map = contextByWord({
      tokens: tokensIn(text, [{ text: "猫" }, { text: "犬" }]),
      meaningsByWord: meanings([
        ["猫", makeWord({ wordId: "neko", input: "猫" })],
        ["犬", makeWord({ wordId: "inu", input: "犬" })],
      ]),
      sentences: sentencesOf(text),
    });

    expect(map.get("neko")?.map((c) => c.text)).toEqual(["猫が好きです。"]);
    expect(map.get("inu")?.map((c) => c.text)).toEqual(["犬も好きです。"]);
  });

  it("gives spans RELATIVE to the sentence, so a later sentence still highlights correctly", () => {
    const map = contextByWord({
      tokens: tokensIn(text, [{ text: "犬" }]),
      meaningsByWord: meanings([["犬", makeWord({ wordId: "inu", input: "犬" })]]),
      sentences: sentencesOf(text),
    });

    const ctx = map.get("inu")![0];
    // 犬 is at offset 7 in the paragraph but offset 0 in its own sentence.
    expect(ctx.spans).toEqual([{ start: 0, end: 1 }]);
    expect(ctx.text.slice(0, 1)).toBe("犬");
  });

  it("collapses a word repeated in ONE sentence into one entry with two spans", () => {
    const t = "猫と猫が遊ぶ。";
    const map = contextByWord({
      tokens: tokensIn(t, [{ text: "猫" }, { text: "猫", nth: 1 }]),
      meaningsByWord: meanings([["猫", makeWord({ wordId: "neko", input: "猫" })]]),
      sentences: sentencesOf(t),
    });

    const ctx = map.get("neko")!;
    expect(ctx).toHaveLength(1);
    expect(ctx[0].spans).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ]);
  });

  it("skips grammatical tokens and words with no dictionary entry", () => {
    const map = contextByWord({
      tokens: tokensIn(text, [{ text: "が", pos: "助詞" }, { text: "好き" }]),
      meaningsByWord: meanings([["猫", makeWord({ wordId: "neko", input: "猫" })]]),
      sentences: sentencesOf(text),
    });
    expect(map.size).toBe(0);
  });

  it("carries the sentence gloss through when the reader has loaded one", () => {
    const map = contextByWord({
      tokens: tokensIn(text, [{ text: "猫" }]),
      meaningsByWord: meanings([["猫", makeWord({ wordId: "neko", input: "猫" })]]),
      sentences: sentencesOf(text, "I like cats."),
    });
    expect(map.get("neko")![0].gloss).toBe("I like cats.");
  });

  it("returns nothing when there are no sentences (never throws)", () => {
    const map = contextByWord({
      tokens: tokensIn(text, [{ text: "猫" }]),
      meaningsByWord: meanings([["猫", makeWord({ wordId: "neko", input: "猫" })]]),
      sentences: [],
    });
    expect(map.size).toBe(0);
  });
});

describe("highlightSegments", () => {
  it("splits into plain / hit parts in document order", () => {
    expect(highlightSegments("猫が好き", [{ start: 0, end: 1 }])).toEqual([
      { text: "猫", hit: true },
      { text: "が好き", hit: false },
    ]);
  });

  it("handles a highlight in the middle and several highlights", () => {
    expect(highlightSegments("猫と猫が", [
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ])).toEqual([
      { text: "猫", hit: true },
      { text: "と", hit: false },
      { text: "猫", hit: true },
      { text: "が", hit: false },
    ]);
  });

  it("ignores out-of-range and overlapping spans rather than corrupting the text", () => {
    const out = highlightSegments("猫が", [
      { start: 5, end: 9 }, // past the end
      { start: 0, end: 1 },
      { start: 0, end: 2 }, // overlaps the previous
    ]);
    expect(out.map((s) => s.text).join("")).toBe("猫が");
  });
});
