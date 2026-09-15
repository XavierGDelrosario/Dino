import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import {
  findCachedWord,
  findWordTranslations,
  findWordTranslationsBatch,
} from "@/services/words/repository";
import { __clearWordsCache } from "@/services/words/cache";
import { FRESH, CURRENT_PROJECTION_VERSION } from "@/lib/projection";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
  __clearWordsCache(); // the read cache is module-global — reset between cases
});

const row = (over: Record<string, unknown> = {}) => ({
  word_id: "w1",
  input: "猫",
  translation: "cat",
  source_lang: "JA",
  target_lang: "EN",
  input_reading: null,
  translation_reading: null,
  jmdict_entry_id: "1467640",
  jmdict_sense_pos: 0,
  is_verified: true,
  ...over,
});

describe("findCachedWord", () => {
  it("maps a snake_case row to a camelCase Word", async () => {
    stub.queueFrom("words", { data: [row()], error: null });
    const word = await findCachedWord({ input: "猫", sourceLang: "JA", targetLang: "EN" });
    expect(word).toEqual({
      wordId: "w1",
      input: "猫",
      translation: "cat",
      sourceLang: "JA",
      targetLang: "EN",
      inputReading: null,
      translationReading: null,
      partOfSpeech: null,
      frequency: null,
      difficultyOverride: null,
      proficiencyBand: null,
      jmdictEntryId: "1467640",
      jmdictSensePos: 0,
      // Sense enrichment (20260750) — null for a row the authored corpus hasn't
      // reached, which is most of them.
      example: null,
      exampleGloss: null,
      definitionSource: null,
      exampleReading: null,
      isCommon: null, // 20260769 — absent on this row, so unknown rather than false
      isVerified: true,
    });
  });

  it("maps the authored sense enrichment when the row carries it", async () => {
    stub.queueFrom("words", {
      data: [
        row({
          example: "このいちごはとても甘い。",
          example_gloss: "These strawberries are very sweet.",
          definition_source: "砂糖や蜜のような味である。",
        }),
      ],
      error: null,
    });
    const word = await findCachedWord({ input: "猫", sourceLang: "JA", targetLang: "EN" });
    expect(word).toMatchObject({
      example: "このいちごはとても甘い。",
      exampleGloss: "These strawberries are very sweet.",
      definitionSource: "砂糖や蜜のような味である。",
    });
  });

  it("carries the reading from whichever side has one (input or translation)", async () => {
    // JA→EN: reading sits on the input (kana over kanji); English side has none.
    stub.queueFrom("words", { data: [row({ input_reading: "ねこ" })], error: null });
    const ja = await findCachedWord({ input: "猫", sourceLang: "JA", targetLang: "EN" });
    expect(ja).toMatchObject({ inputReading: "ねこ", translationReading: null });

    // EN→JA: reading sits on the translation (the Japanese side).
    stub.queueFrom("words", {
      data: [row({ input: "cat", translation: "猫", source_lang: "EN", target_lang: "JA", translation_reading: "ねこ" })],
      error: null,
    });
    const en = await findCachedWord({ input: "cat", sourceLang: "EN", targetLang: "JA" });
    expect(en).toMatchObject({ inputReading: null, translationReading: "ねこ" });
  });

  it("returns null when there is no match", async () => {
    stub.queueFrom("words", { data: [], error: null });
    expect(await findCachedWord({ input: "x", sourceLang: "JA", targetLang: "EN" })).toBeNull();
  });

  it("throws the PostgREST error", async () => {
    stub.queueFrom("words", { data: null, error: new Error("db down") });
    await expect(
      findCachedWord({ input: "猫", sourceLang: "JA", targetLang: "EN" })
    ).rejects.toThrow("db down");
  });
});

describe("findWordTranslationsBatch", () => {
  it("returns an empty map without querying for empty input", async () => {
    const map = await findWordTranslationsBatch({ inputs: [], sourceLang: "JA", targetLang: "EN" });
    expect(map.size).toBe(0);
    expect(stub.fromCalls).toEqual([]); // no DB round-trip
  });

  it("groups rows by input word", async () => {
    stub.queueFrom("words", {
      data: [
        row({ word_id: "a1", input: "猫", translation: "cat" }),
        row({ word_id: "b1", input: "高い", translation: "high" }),
        row({ word_id: "b2", input: "高い", translation: "expensive" }),
      ],
      error: null,
    });
    const map = await findWordTranslationsBatch({
      inputs: ["猫", "高い", "猫"], // duplicate de-duped before querying
      sourceLang: "JA",
      targetLang: "EN",
    });
    expect(map.get("猫")).toHaveLength(1);
    expect(map.get("高い")?.map((w) => w.translation)).toEqual(["high", "expensive"]);
  });
});

describe("read-through cache", () => {
  it("serves a repeated findWordTranslations from memory (one DB round-trip)", async () => {
    stub.queueFrom("words", { data: [row()], error: null });
    const first = await findWordTranslations({ input: "猫", sourceLang: "JA", targetLang: "EN" });
    const second = await findWordTranslations({ input: "猫", sourceLang: "JA", targetLang: "EN" });
    expect(second).toEqual(first);
    expect(stub.fromCalls).toEqual(["words"]); // second call hit the cache, not the DB
  });

  it("does NOT cache an empty (negative) result — a later populate is seen", async () => {
    stub.queueFrom(
      "words",
      { data: [], error: null }, // first lookup: nothing cached yet
      { data: [row()], error: null }, // edge populated `words`; second lookup finds it
    );
    expect(await findWordTranslations({ input: "猫", sourceLang: "JA", targetLang: "EN" })).toEqual([]);
    const second = await findWordTranslations({ input: "猫", sourceLang: "JA", targetLang: "EN" });
    expect(second).toHaveLength(1);
    expect(stub.fromCalls).toEqual(["words", "words"]); // both hit the DB (empty wasn't memoized)
  });

  it("findWordTranslationsBatch queries only the inputs not already cached", async () => {
    // Prime the cache for 猫 via a single lookup.
    stub.queueFrom("words", { data: [row()], error: null });
    await findWordTranslations({ input: "猫", sourceLang: "JA", targetLang: "EN" });

    // Batch asks for 猫 (cached) + 犬 (miss) — only 犬 should be queried.
    stub.queueFrom("words", { data: [row({ word_id: "d1", input: "犬", translation: "dog" })], error: null });
    const map = await findWordTranslationsBatch({
      inputs: ["猫", "犬"],
      sourceLang: "JA",
      targetLang: "EN",
    });
    expect(map.get("猫")?.[0]?.translation).toBe("cat");
    expect(map.get("犬")?.[0]?.translation).toBe("dog");
    expect(stub.fromCalls).toEqual(["words", "words"]); // lookup + batch's miss-only query
  });

  it("findCachedWord returns the preferred sense from the cache without a query", async () => {
    stub.queueFrom("words", {
      data: [row({ word_id: "p", jmdict_sense_pos: 0 }), row({ word_id: "s", jmdict_sense_pos: 1 })],
      error: null,
    });
    await findWordTranslations({ input: "猫", sourceLang: "JA", targetLang: "EN" });

    const preferred = await findCachedWord({ input: "猫", sourceLang: "JA", targetLang: "EN" });
    expect(preferred?.wordId).toBe("p");
    expect(stub.fromCalls).toEqual(["words"]); // findCachedWord served from cache
  });
});

describe("NFC normalization at the cache + DB boundary", () => {
  // が: U+304C (composed, what the edge stores) vs か + combining dakuten
  // U+304B U+3099 (decomposed) — NFC unifies them. A caller that forgot to
  // normalize must NOT fork the cache key or miss the stored row.
  const COMPOSED = "\u304C"; // が (precomposed)
  const DECOMPOSED = "\u304B\u3099"; // か + combining dakuten → NFC → が

  it("queries the DB with the NFC-composed input, even given a decomposed one", async () => {
    stub.queueFrom("words", { data: [], error: null });
    await findWordTranslations({ input: DECOMPOSED, sourceLang: "JA", targetLang: "EN" });
    const inInput = stub.callsFor("words", "in").find((c) => c.args[0] === "input");
    expect(inInput?.args[1]).toEqual([COMPOSED]); // normalized for the query, not raw decomposed
  });

  it("a decomposed lookup hits a cache entry primed under the composed form", async () => {
    stub.queueFrom("words", { data: [row()], error: null });
    await findWordTranslations({ input: COMPOSED, sourceLang: "JA", targetLang: "EN" }); // primes
    const hit = await findWordTranslations({ input: DECOMPOSED, sourceLang: "JA", targetLang: "EN" });
    expect(hit).toHaveLength(1);
    expect(stub.fromCalls).toEqual(["words"]); // 2nd call served from cache — same key
  });

  it("findWordTranslationsBatch normalizes each input before the .in() query", async () => {
    stub.queueFrom("words", { data: [], error: null });
    await findWordTranslationsBatch({ inputs: [DECOMPOSED], sourceLang: "JA", targetLang: "EN" });
    const inCall = stub.callsFor("words", "in").find((c) => c.args[0] === "input");
    expect(inCall?.args[1]).toEqual([COMPOSED]);
  });
});

// The client reads `words` DIRECTLY and short-circuits the edge on a hit — so if it
// serves a row projected by older logic, the edge never gets the chance to re-project
// it and the improvement never reaches that word. Every read must carry the gate.
describe("stale-projection gate", () => {
  it.each([
    ["findCachedWord", () => findCachedWord({ input: "猫", sourceLang: "JA", targetLang: "EN" })],
    ["findWordTranslations", () => findWordTranslations({ input: "猫", sourceLang: "JA", targetLang: "EN" })],
    ["findWordTranslationsBatch", () => findWordTranslationsBatch({ inputs: ["猫"], sourceLang: "JA", targetLang: "EN" })],
  ])("%s only serves CURRENT projections (MT rows included)", async (_name, read) => {
    stub.queueFrom("words", { data: [], error: null });

    await read();

    const or = stub.callsFor("words", "or")[0];
    expect(or?.args[0]).toBe(FRESH);
    expect(FRESH).toBe(`projection_version.gte.${CURRENT_PROJECTION_VERSION}`);
    // MT rows are NOT exempt (v8): the client must miss a stale one so the edge gets to
    // re-check the dictionary for free (it revives the paid row if nothing turns up).
    expect(FRESH).not.toContain("mt:");
  });
});

// Quality report #24. A `uk` entry headwords as its KANA and keeps the kanji in
// input_reading, so reading `words` by input alone found only 為 read い ("the second
// string of a koto") for 為 — and served it, because a client hit never asks the edge.
describe("a kanji term also collects the uk rows written that way", () => {
  const koto = row({ word_id: "koto", input: "為", input_reading: "い", translation: "koto string", jmdict_entry_id: "2870964", frequency: 514, is_common: false });
  const tame = row({ word_id: "tame", input: "ため", input_reading: "為", translation: "sake; purpose", jmdict_entry_id: "1157080", frequency: 611, is_common: true });
  const suru = row({ word_id: "su", input: "す", input_reading: "為", translation: "to do", jmdict_entry_id: "2219050", frequency: 533, is_common: true });

  it("queries input_reading for a kanji term, quoted", async () => {
    stub.queueFrom("words", { data: [], error: null });
    await findWordTranslations({ input: "為", sourceLang: "JA", targetLang: "EN" });
    const filters = stub.callsFor("words", "or").map((c) => c.args[0]);
    expect(filters).toContain('input.in.("為"),input_reading.in.("為")');
    expect(stub.callsFor("words", "in")).toEqual([]);
  });

  it("keeps a kana term on input alone — the edge resolves those", async () => {
    stub.queueFrom("words", { data: [], error: null });
    await findWordTranslations({ input: "ねこ", sourceLang: "JA", targetLang: "EN" });
    expect(stub.callsFor("words", "in").map((c) => c.args)).toEqual([["input", ["ねこ"]]]);
  });

  it("answers 為 with ため: a common word outranks a rare entry merely written this way", async () => {
    stub.queueFrom("words", { data: [koto, tame, suru], error: null });
    const senses = await findWordTranslations({ input: "為", sourceLang: "JA", targetLang: "EN" });
    expect(senses.map((w) => w.wordId)).toEqual(["tame", "su", "koto"]);
    __clearWordsCache();
    stub.queueFrom("words", { data: [koto, tame, suru], error: null });
    expect((await findCachedWord({ input: "為", sourceLang: "JA", targetLang: "EN" }))?.wordId).toBe("tame");
  });

  it("the batch read assigns a uk row to the kanji term, and still to its own kana", async () => {
    stub.queueFrom("words", { data: [koto, tame, suru], error: null });
    const map = await findWordTranslationsBatch({ inputs: ["為", "ため"], sourceLang: "JA", targetLang: "EN" });
    expect(map.get("為")?.map((w) => w.wordId)).toEqual(["tame", "su", "koto"]);
    expect(map.get("ため")?.map((w) => w.wordId)).toEqual(["tame"]);
  });
});
