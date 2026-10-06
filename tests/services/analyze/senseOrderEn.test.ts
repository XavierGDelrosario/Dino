// English sense-in-context ordering: the tagger's POS group leads, definition overlap
// decides within it, and — like the Japanese reading rule — it declines rather than
// guesses, never drops a sense, and leaves the dictionary order alone under doubt.
import { describe, expect, it } from "vitest";
import {
  contextWindows,
  definitionWords,
  orderSensesByContextEn,
  senseLetters,
} from "@/services/analyze/senseOrderEn";
import { orderSensesForToken } from "@/services/analyze/senseOrder";
import type { AnalyzedToken } from "@/services/language";

const sense = (id: string, pos: string[] | null, def: string | null) => ({
  id,
  partOfSpeech: pos,
  definitionSource: def,
  inputReading: null as string | null,
  input: id,
});
const ids = (list: { id: string }[]) => list.map((s) => s.id);

// "spring": three nouns and a verb, as the EN→JA rows carry them.
const SEASON = sense("春", ["n"], 'the season of growth; "the emerging buds were a sure sign of spring"');
const WATER = sense("泉", ["n"], "a natural flow of ground water");
const COIL = sense("ばね", ["n"], "a metal elastic device that returns to its shape or position when pushed or pulled or pressed");
const JUMP = sense("弾む", ["v"], "move forward by leaps and bounds");

const tok = (text: string, pos: string, lemma: string | null = null): AnalyzedToken =>
  ({ text, start: 0, end: text.length, reading: null, lemma, pos }) as AnalyzedToken;

describe("orderSensesByContextEn — the POS gate", () => {
  it("leads with the senses of the tagger's part of speech", () => {
    expect(ids(orderSensesByContextEn([SEASON, WATER, COIL, JUMP], "VERB", undefined))).toEqual(["弾む", "春", "泉", "ばね"]);
  });
  it("leaves the order alone when the tag matches every sense, or none", () => {
    const nouns = [SEASON, WATER, COIL];
    expect(orderSensesByContextEn(nouns, "NOUN", undefined)).toBe(nouns);
    expect(orderSensesByContextEn(nouns, "VERB", undefined)).toBe(nouns);
    expect(orderSensesByContextEn(nouns, "DET", undefined)).toBe(nouns);
  });
  it("reads JMdict codes on older cached rows as the same classes", () => {
    expect([...senseLetters(["adj-i"])]).toEqual(["a"]);
    expect([...senseLetters(["v5r", "vt"])]).toEqual(["v"]);
    expect([...senseLetters(["n", "s"])].sort()).toEqual(["a", "n"]);
    expect(senseLetters(null).size).toBe(0);
  });
});

describe("orderSensesByContextEn — definition overlap", () => {
  it("promotes the sense whose definition shares words with the sentence", () => {
    const ctx = new Set(["water", "flow", "mountain"]);
    expect(ids(orderSensesByContextEn([SEASON, WATER, COIL], "NOUN", ctx))).toEqual(["泉", "春", "ばね"]);
  });
  it("works inside the POS group only — a verb context never lifts a noun", () => {
    const ctx = new Set(["water", "flow"]);
    expect(ids(orderSensesByContextEn([SEASON, WATER, COIL, JUMP], "VERB", ctx))).toEqual(["弾む", "春", "泉", "ばね"]);
  });
  it("keeps the dictionary order when nothing overlaps, or on a tie at the top", () => {
    const list = [SEASON, WATER, COIL];
    expect(orderSensesByContextEn(list, "NOUN", new Set(["banana"]))).toBe(list);
    // SEASON and WATER both score 1 → the one already first stays first.
    expect(orderSensesByContextEn(list, "NOUN", new Set(["growth", "water"]))).toBe(list);
  });
  it("is a REORDER — every sense survives, relative order kept among equals", () => {
    const out = orderSensesByContextEn([SEASON, WATER, COIL, JUMP], "NOUN", new Set(["metal", "device"]));
    expect(ids(out)).toEqual(["ばね", "春", "泉", "弾む"]);
    expect(out).toHaveLength(4);
  });
  it("scores a missing definition as zero instead of failing", () => {
    const bare = sense("x", ["n"], null);
    expect(ids(orderSensesByContextEn([bare, WATER], "NOUN", new Set(["water"])))).toEqual(["泉", "x"]);
  });
  it("fewer than two senses: untouched", () => {
    const one = [WATER];
    expect(orderSensesByContextEn(one, "NOUN", new Set(["water"]))).toBe(one);
  });
});

describe("definitionWords", () => {
  it("lowercases, lemmatizes, and drops function words and stubs", () => {
    const w = definitionWords('the emerging buds were a sure sign of spring; "flows of waters"');
    expect(w.has("the")).toBe(false);
    expect(w.has("bud")).toBe(true); // buds → bud
    expect(w.has("water")).toBe(true); // waters → water
    expect(w.has("of")).toBe(false);
  });
});

describe("contextWindows", () => {
  it("collects the content words around each ENGLISH token, excluding itself", () => {
    const tokens = [tok("Fresh", "ADJ"), tok("water", "NOUN"), tok("from", "ADP"), tok("the", "DET"), tok("spring", "NOUN"), tok("flows", "VERB", "flow")];
    const ctx = contextWindows(tokens);
    const spring = ctx.get(tokens[4])!;
    expect(spring.has("water")).toBe(true);
    expect(spring.has("flow")).toBe(true); // the lemma counts
    expect(spring.has("spring")).toBe(false);
    expect(spring.has("the")).toBe(false);
  });
  it("gives Japanese tokens no entry", () => {
    const ctx = contextWindows([tok("猫", "名詞"), tok("が", "助詞")]);
    expect(ctx.size).toBe(0);
  });
  it("stays within the window", () => {
    // Letter-only names: digits are stripped from a context word, so "word13" would
    // collapse to "word".
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    const far = names.map((n) => tok(n, "NOUN"));
    const ctx = contextWindows(far, 2);
    const mid = ctx.get(far[5])!; // foxtrot: window = delta, echo | golf, hotel
    expect(mid.has("delta")).toBe(true);
    expect(mid.has("hotel")).toBe(true);
    expect(mid.has("charlie")).toBe(false);
    expect(mid.has("india")).toBe(false);
  });
});

describe("orderSensesForToken — the dispatch", () => {
  it("routes an English token to the POS/definition rule", () => {
    const t = tok("spring", "VERB");
    expect(ids(orderSensesForToken([SEASON, JUMP], t, new Set()))).toEqual(["弾む", "春"]);
  });
  it("routes a Japanese token to the reading rule", () => {
    const karai = { ...sense("karai", null, null), inputReading: "からい", input: "辛い" };
    const tsurai = { ...sense("tsurai", null, null), inputReading: "つらい", input: "辛い" };
    const t = { ...tok("辛い", "形容詞"), reading: "つらい" };
    expect(ids(orderSensesForToken([karai, tsurai], t))).toEqual(["tsurai", "karai"]);
  });
});
