import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import {
  findCachedWord,
  findWordTranslationsBatch,
} from "@/services/words/repository";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
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
      jmdictEntryId: "1467640",
      jmdictSensePos: 0,
      isVerified: true,
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
