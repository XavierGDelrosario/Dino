import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as any } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import { getListWords, getUserWordStates } from "@/services/words/queries";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
});

const wordsCol = (over: Record<string, unknown> = {}) => ({
  word_id: "w1",
  input: "猫",
  translation: "cat",
  source_lang: "JA",
  target_lang: "EN",
  is_verified: true,
  created_by: "system",
  ...over,
});

describe("getListWords", () => {
  it("joins words with mastery and skips junction rows with a null word", async () => {
    stub.queueFrom("list_words", {
      data: [
        { word_id: "w1", words: wordsCol({ word_id: "w1" }) },
        { word_id: "w2", words: null }, // dangling junction row → filtered out
      ],
      error: null,
    });
    stub.queueFrom("user_word_mastery", {
      data: [
        {
          word_id: "w1",
          confidence_rating: 3,
          last_reviewed_date: "2026-06-01",
          next_review_date: "2026-06-10",
        },
      ],
      error: null,
    });

    const entries = await getListWords({ userId: "u", listId: "l1" });
    expect(entries).toHaveLength(1);
    expect(entries[0].word.wordId).toBe("w1");
    expect(entries[0].confidenceRating).toBe(3);
    expect(entries[0].nextReviewDate).toBe("2026-06-10");
  });

  it("defaults confidence to 0 when a word has no mastery row", async () => {
    stub.queueFrom("list_words", {
      data: [{ word_id: "w1", words: wordsCol() }],
      error: null,
    });
    stub.queueFrom("user_word_mastery", { data: [], error: null });

    const [entry] = await getListWords({ userId: "u", listId: "l1" });
    expect(entry.confidenceRating).toBe(0);
    expect(entry.lastReviewedDate).toBeNull();
  });

  it("short-circuits to [] without querying mastery for an empty list", async () => {
    stub.queueFrom("list_words", { data: [], error: null });
    expect(await getListWords({ userId: "u", listId: "l1" })).toEqual([]);
    expect(stub.fromCalls).toEqual(["list_words"]); // mastery never queried
  });
});

describe("getUserWordStates", () => {
  it("returns an entry for every id, defaulting unknown ones to not-tracked", async () => {
    stub.queueFrom("user_word_mastery", {
      data: [
        {
          word_id: "w1",
          confidence_rating: 5,
          last_reviewed_date: "2026-06-01",
          next_review_date: "2026-06-10",
        },
      ],
      error: null,
    });

    const states = await getUserWordStates({ userId: "u", wordIds: ["w1", "w2"] });
    expect(states.get("w1")).toEqual({
      tracked: true,
      confidenceRating: 5,
      lastReviewedDate: "2026-06-01",
      nextReviewDate: "2026-06-10",
    });
    expect(states.get("w2")).toEqual({
      tracked: false,
      confidenceRating: 0,
      lastReviewedDate: null,
      nextReviewDate: null,
    });
  });

  it("returns an empty map without querying for no ids", async () => {
    const states = await getUserWordStates({ userId: "u", wordIds: [] });
    expect(states.size).toBe(0);
    expect(stub.fromCalls).toEqual([]);
  });
});
