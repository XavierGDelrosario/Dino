// English sense-in-context ordering: the tagger's POS group leads, definition overlap
// decides within it, and — like the Japanese reading rule — it declines rather than
// guesses, never drops a sense, and leaves the dictionary order alone under doubt.
import { describe, expect, it, beforeAll } from "vitest";
import {
  contextWindows,
  definitionWords,
  orderSensesByContextEn,
  senseLetters,
} from "@/services/analyze/senseOrderEn";
import { orderSensesForToken } from "@/services/analyze/senseOrder";
import { loadEnglishBaseForms } from "@/services/language/lemmaEn";
import type { AnalyzedToken } from "@/services/language";

beforeAll(() => loadEnglishBaseForms());

const sense = (id: string, pos: string[] | null, def: string | null, input = "spring") => ({
  id,
  partOfSpeech: pos,
  definitionSource: def,
  inputReading: null as string | null,
  input,
});
const ids = (list: { id: string }[]) => list.map((s) => s.id);
const order = (senses: ReturnType<typeof sense>[], tag: string | null, context?: Set<string>) =>
  orderSensesByContextEn({ senses, tag, context });

// "spring": three nouns and a verb, as the EN→JA rows carry them.
const SEASON = sense("春", ["n"], 'the season of growth; "the emerging buds were a sure sign of spring"');
const WATER = sense("泉", ["n"], "a natural flow of ground water");
const COIL = sense("ばね", ["n"], "a metal elastic device that returns to its shape or position when pushed or pulled or pressed");
const JUMP = sense("弾む", ["v"], "move forward by leaps and bounds");

const tok = (text: string, pos: string, lemma: string | null = null): AnalyzedToken =>
  ({ text, start: 0, end: text.length, reading: null, lemma, pos }) as AnalyzedToken;

describe("orderSensesByContextEn — the POS gate", () => {
  it("leads with the senses of the tagger's part of speech", () => {
    expect(ids(order([SEASON, WATER, COIL, JUMP], "VERB"))).toEqual(["弾む", "春", "泉", "ばね"]);
  });
  it("leaves the order alone when the tag matches every sense, or none", () => {
    const nouns = [SEASON, WATER, COIL];
    expect(order(nouns, "NOUN")).toBe(nouns);
    expect(order(nouns, "VERB")).toBe(nouns);
    expect(order(nouns, "DET")).toBe(nouns);
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
    expect(ids(order([SEASON, WATER, COIL], "NOUN", ctx))).toEqual(["泉", "春", "ばね"]);
  });
  it("works inside the POS group only — a verb context never lifts a noun", () => {
    const ctx = new Set(["water", "flow"]);
    expect(ids(order([SEASON, WATER, COIL, JUMP], "VERB", ctx))).toEqual(["弾む", "春", "泉", "ばね"]);
  });
  it("a single shared word moves the primary only when no OTHER sense shares any", () => {
    // Only 泉 touches the sentence → one word is enough.
    expect(ids(order([SEASON, WATER, COIL], "NOUN", new Set(["water"])))).toEqual(["泉", "春", "ばね"]);
    // 泉 and ばね each share one word with the sentence → too thin, dictionary order stands.
    const list = [SEASON, WATER, COIL];
    expect(order(list, "NOUN", new Set(["water", "metal"]))).toBe(list);
  });
  it("two shared words beat the primary even when another sense shares one", () => {
    expect(ids(order([SEASON, WATER, COIL], "NOUN", new Set(["metal", "device", "water"])))).toEqual(["ばね", "春", "泉"]);
  });
  it("keeps the dictionary order when nothing overlaps, or when the top score is shared", () => {
    const list = [SEASON, WATER, COIL];
    expect(order(list, "NOUN", new Set(["banana"]))).toBe(list);
    // WATER and COIL both score 2 → no evidence between them → untouched.
    expect(order(list, "NOUN", new Set(["water", "flow", "metal", "device"]))).toBe(list);
  });
  it("WordNet boilerplate never votes: 'something' alone moves nothing", () => {
    const elastic = sense("弾力", ["n"], "the elasticity of something that can be stretched and returns to its original length");
    const list = [SEASON, elastic];
    expect(order(list, "NOUN", new Set(["something", "happen"]))).toBe(list);
  });
  it("a sense's own headword in its example does not count (a repeated word can't promote it)", () => {
    const list = [WATER, SEASON]; // SEASON's example quotes "spring"
    expect(order(list, "NOUN", new Set(["spring"]))).toBe(list);
  });
  it("is a REORDER — every sense survives, relative order kept among the rest", () => {
    const out = order([SEASON, WATER, COIL, JUMP], "NOUN", new Set(["metal", "device"]));
    expect(ids(out)).toEqual(["ばね", "春", "泉", "弾む"]);
    expect(out).toHaveLength(4);
  });
  it("scores a missing definition as zero instead of failing", () => {
    const bare = sense("x", ["n"], null);
    expect(ids(order([bare, WATER], "NOUN", new Set(["water"])))).toEqual(["泉", "x"]);
  });
  it("fewer than two senses: untouched", () => {
    const one = [WATER];
    expect(order(one, "NOUN", new Set(["water"]))).toBe(one);
  });
});

describe("definitionWords", () => {
  it("lowercases, lemmatizes, and drops function words, boilerplate and stubs", () => {
    const w = definitionWords('the emerging buds were a sure sign of something; "flows of waters"');
    expect(w.has("the")).toBe(false);
    expect(w.has("something")).toBe(false);
    expect(w.has("bud")).toBe(true); // buds → bud
    expect(w.has("water")).toBe(true); // waters → water
  });
  it("normalizes to NFC before comparing", () => {
    const nfc = definitionWords("caf\u00e9");
    const nfd = definitionWords("cafe\u0301");
    expect([...nfc]).toEqual([...nfd]);
  });
});

describe("contextWindows", () => {
  it("collects the content words around each ENGLISH token, excluding its own word", () => {
    const tokens = [tok("Fresh", "ADJ"), tok("water", "NOUN"), tok("from", "ADP"), tok("the", "DET"), tok("spring", "NOUN"), tok("flows", "VERB", "flow")];
    const ctx = contextWindows(tokens);
    const spring = ctx.get(tokens[4])!;
    expect(spring.has("water")).toBe(true);
    expect(spring.has("flow")).toBe(true); // the lemma counts
    expect(spring.has("spring")).toBe(false);
    expect(spring.has("the")).toBe(false);
  });
  it("excludes OTHER occurrences of the same word, not just the token itself", () => {
    const tokens = [tok("The", "DET"), tok("light", "NOUN"), tok("was", "AUX"), tok("on", "ADP"), tok("so", "ADV"), tok("I", "PRON"), tok("turned", "VERB", "turn"), tok("off", "ADP"), tok("the", "DET"), tok("light", "NOUN")];
    const ctx = contextWindows(tokens);
    expect(ctx.get(tokens[1])!.has("light")).toBe(false);
    expect(ctx.get(tokens[9])!.has("light")).toBe(false);
    expect(ctx.get(tokens[9])!.has("turn")).toBe(true);
  });
  it("gives Japanese tokens no entry", () => {
    const ctx = contextWindows([tok("猫", "名詞"), tok("が", "助詞")]);
    expect(ctx.size).toBe(0);
  });
  it("stays within the window", () => {
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    const far = names.map((n) => tok(n, "NOUN"));
    const ctx = contextWindows(far, { window: 2 });
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
    expect(ids(orderSensesForToken({ senses: [SEASON, JUMP], token: t, context: new Set() }))).toEqual(["弾む", "春"]);
  });
  it("routes a Japanese token to the reading rule", () => {
    const karai = { ...sense("karai", null, null, "辛い"), inputReading: "からい" };
    const tsurai = { ...sense("tsurai", null, null, "辛い"), inputReading: "つらい" };
    const t = { ...tok("辛い", "形容詞"), reading: "つらい" };
    expect(ids(orderSensesForToken({ senses: [karai, tsurai], token: t }))).toEqual(["tsurai", "karai"]);
  });
});
