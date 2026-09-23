// The client's sense order must match the edge's, or one word shows two different
// primaries depending on which side served it.
import { describe, it, expect } from "vitest";
import { orderSenses, preferWrittenForm } from "@/services/words/senseOrder";
import { preferWrittenForm as edgePreferWrittenForm } from "../../../supabase/functions/translate/_lib";
import { makeWord } from "@test/fixtures";

const w = (id: string, input: string, over: Parameters<typeof makeWord>[0] = {}) =>
  makeWord({ wordId: id, input, ...over });

describe("orderSenses", () => {
  it("JA→EN: the most frequent ENTRY leads, its senses keep their order", () => {
    const senses = [
      w("a0", "顔", { jmdictEntryId: "2", frequency: 300 }),
      w("b0", "顔", { jmdictEntryId: "1", frequency: 600 }),
      w("a1", "顔", { jmdictEntryId: "2", frequency: 300 }),
      w("b1", "顔", { jmdictEntryId: "1", frequency: 600 }),
    ];
    expect(orderSenses(senses, "顔", "JA", "EN").map((s) => s.wordId)).toEqual(["b0", "b1", "a0", "a1"]);
  });

  // Quality report #30. いい and 謂 (a rare uk noun) share the kana's frequency and 謂
  // has the lower entry id — jmdict_lookup breaks that tie on is_common, so must this.
  it("JA→EN: a frequency tie goes to the COMMON entry before the lower entry id", () => {
    const senses = [
      w("iu", "いい", { jmdictEntryId: "2672300", frequency: 637, isCommon: false }),
      w("good", "いい", { jmdictEntryId: "2820690", frequency: 637, isCommon: true }),
    ];
    expect(orderSenses(senses, "いい", "JA", "EN").map((s) => s.wordId)).toEqual(["good", "iu"]);
  });

  it("EN→JA keeps the projected rank order", () => {
    const senses = [w("x", "cat", { frequency: 1 }), w("y", "cat", { frequency: 900 })];
    expect(orderSenses(senses, "cat", "EN", "JA").map((s) => s.wordId)).toEqual(["x", "y"]);
  });
});

describe("preferWrittenForm — client and edge agree", () => {
  const cases: { term: string; rows: { input: string; common: boolean | null }[] }[] = [
    { term: "為", rows: [{ input: "為", common: false }, { input: "ため", common: true }, { input: "す", common: true }] },
    { term: "質", rows: [{ input: "たち", common: true }, { input: "質", common: true }] },
    { term: "栄", rows: [{ input: "ロン", common: false }, { input: "栄", common: false }] },
    { term: "猫", rows: [{ input: "ねこ", common: null }, { input: "猫", common: null }] },
    { term: "ねこ", rows: [{ input: "猫", common: true }, { input: "ねこ", common: false }] },
  ];

  it.each(cases)("$term", ({ term, rows }) => {
    const client = preferWrittenForm(rows.map((r, i) => w(String(i), r.input, { isCommon: r.common })), term);
    const edge = edgePreferWrittenForm(rows.map((r, i) => ({ id: String(i), input: r.input, is_common: r.common })), term);
    expect(client.map((r) => r.wordId)).toEqual(edge.map((r) => r.id));
  });
});
