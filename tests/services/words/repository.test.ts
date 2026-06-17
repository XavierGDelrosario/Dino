import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as any } }));
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
  is_verified: true,
  created_by: "system",
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
      isVerified: true,
      createdBy: "system",
    });
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
