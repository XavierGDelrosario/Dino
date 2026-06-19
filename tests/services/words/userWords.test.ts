import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";
import { makeWord } from "@test/fixtures";

const { holder } = vi.hoisted(() => ({ holder: { client: null as any } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import {
  saveDictionaryWord,
  createCustomWord,
  editUserWord,
  deleteUserWord,
  addUserWordToList,
  removeUserWordFromList,
  getAllUserWords,
  getUserWordsInList,
  getUserWordStates,
} from "@/services/words/userWords";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
});

/** A raw user_words DB row (snake_case), with optional embedded dictionary word. */
const uwRow = (over: Record<string, unknown> = {}) => ({
  user_word_id: "uw1",
  user_id: "u",
  input: "猫",
  source_lang: "JA",
  target_lang: "EN",
  dictionary_word_id: "ja-neko",
  custom_translation: null,
  confidence_rating: 0,
  last_reviewed_date: null,
  originally_translated_date: "2026-06-17T00:00:00Z",
  ...over,
});

// save/create now go through ONE atomic Postgres function (save_dictionary_word
// / create_custom_word) that does the entry-create AND the optional sub-list tag
// in a single transaction — so the client makes one rpc call, not an
// upsert/insert followed by a separate list_words write. The idempotent
// re-create (the partial-unique re-fetch) lives inside create_custom_word now;
// like record_review it runs in Postgres, so it's covered by the integration
// spec / manual checks, not this mocked unit suite.
describe("saveDictionaryWord", () => {
  it("creates an entry referencing the dictionary sense via one atomic RPC", async () => {
    stub.rpc.mockResolvedValue({ data: uwRow(), error: null });
    const word = makeWord({ wordId: "ja-neko", input: "猫", translation: "cat" });

    const res = await saveDictionaryWord({ userId: "u", word });

    expect(stub.rpc).toHaveBeenCalledWith("save_dictionary_word", {
      p_user_id: "u",
      p_dictionary_word_id: "ja-neko",
      p_list_id: null,
    });
    expect(res).toMatchObject({
      dictionaryWordId: "ja-neko",
      customTranslation: null,
      translation: "cat", // resolved from the dictionary sense (patched from the Word)
    });
    expect(stub.callsFor("list_words", "upsert")).toHaveLength(0); // no separate client tag
  });

  it("passes the sub-list id to the RPC when provided", async () => {
    stub.rpc.mockResolvedValue({ data: uwRow(), error: null });
    const word = makeWord({ wordId: "ja-neko" });

    await saveDictionaryWord({ userId: "u", word, listId: "verbs" });

    expect(stub.rpc).toHaveBeenCalledWith("save_dictionary_word", {
      p_user_id: "u",
      p_dictionary_word_id: "ja-neko",
      p_list_id: "verbs",
    });
  });

  it("unwraps a single row returned as an array", async () => {
    stub.rpc.mockResolvedValue({ data: [uwRow()], error: null });
    const word = makeWord({ wordId: "ja-neko", translation: "cat" });

    const res = await saveDictionaryWord({ userId: "u", word });

    expect(res).toMatchObject({ userWordId: "uw1", translation: "cat" });
  });
});

describe("createCustomWord", () => {
  it.each([
    ["empty word", { input: "  ", translation: "cat" }],
    ["empty translation", { input: "猫", translation: " " }],
  ])("throws when %s (no DB write)", async (_label, { input, translation }) => {
    await expect(
      createCustomWord({ userId: "u", input, translation, sourceLang: "JA", targetLang: "EN" })
    ).rejects.toThrow(/required/i);
    expect(stub.rpc).not.toHaveBeenCalled();
  });

  it("creates a standalone entry via one atomic RPC, NFC-trimmed", async () => {
    stub.rpc.mockResolvedValue({
      data: uwRow({ dictionary_word_id: null, custom_translation: "my meaning" }),
      error: null,
    });

    const res = await createCustomWord({
      userId: "u",
      input: "  猫  ",
      translation: "  my meaning  ",
      sourceLang: "JA",
      targetLang: "EN",
    });

    // NFC-trimmed values reach the RPC; the create + tag are atomic server-side.
    expect(stub.rpc).toHaveBeenCalledWith("create_custom_word", {
      p_user_id: "u",
      p_input: "猫",
      p_translation: "my meaning",
      p_source: "JA",
      p_target: "EN",
      p_list_id: null,
    });
    expect(res).toMatchObject({ dictionaryWordId: null, translation: "my meaning" });
  });

  it("passes the sub-list id to the RPC when provided", async () => {
    stub.rpc.mockResolvedValue({
      data: uwRow({ dictionary_word_id: null, custom_translation: "m" }),
      error: null,
    });

    await createCustomWord({
      userId: "u",
      input: "猫",
      translation: "m",
      sourceLang: "JA",
      targetLang: "EN",
      listId: "verbs",
    });

    expect(stub.rpc).toHaveBeenCalledWith(
      "create_custom_word",
      expect.objectContaining({ p_list_id: "verbs" })
    );
  });

  it("rethrows a DB error from the RPC", async () => {
    stub.rpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "permission denied" },
    });
    await expect(
      createCustomWord({
        userId: "u",
        input: "猫",
        translation: "x",
        sourceLang: "JA",
        targetLang: "EN",
      })
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("editUserWord", () => {
  it("rejects an empty meaning", async () => {
    await expect(editUserWord({ userWordId: "uw1", translation: "  " })).rejects.toThrow(/required/i);
  });

  it("overrides the meaning IN PLACE (update, never a new row)", async () => {
    stub.queueFrom("user_words", {
      data: uwRow({ custom_translation: "new meaning" }),
      error: null,
    });

    const res = await editUserWord({ userWordId: "uw1", translation: "  new meaning  " });

    expect(stub.callsFor("user_words", "update")[0]?.args[0]).toEqual({
      custom_translation: "new meaning",
    });
    // The key anti-duplication guarantee: edit is an UPDATE, not an upsert/insert.
    expect(stub.callsFor("user_words", "upsert")).toHaveLength(0);
    expect(stub.callsFor("user_words", "insert")).toHaveLength(0);
    expect(res.translation).toBe("new meaning");
  });
});

describe("deleteUserWord", () => {
  it("deletes the entry and touches nothing else (tags cascade in the DB)", async () => {
    stub.queueFrom("user_words", { data: null, error: null });
    await expect(deleteUserWord({ userWordId: "uw1" })).resolves.toBeUndefined();
    expect(stub.callsFor("user_words", "delete")).toHaveLength(1);
    expect(stub.fromCalls).toEqual(["user_words"]); // no manual list_words cleanup
  });
});

describe("sub-list tagging", () => {
  it("addUserWordToList upserts a tag", async () => {
    stub.queueFrom("list_words", { data: null, error: null });
    await addUserWordToList({ listId: "verbs", userWordId: "uw1" });
    expect(stub.callsFor("list_words", "upsert")[0]?.args[0]).toEqual({
      list_id: "verbs",
      user_word_id: "uw1",
    });
  });

  it("the same word can be tagged into multiple sub-lists", async () => {
    stub.queueFrom("list_words", { data: null, error: null }, { data: null, error: null });
    await addUserWordToList({ listId: "verbs", userWordId: "uw1" });
    await addUserWordToList({ listId: "animals", userWordId: "uw1" });
    expect(stub.callsFor("list_words", "upsert").map((c) => c.args[0])).toEqual([
      { list_id: "verbs", user_word_id: "uw1" },
      { list_id: "animals", user_word_id: "uw1" },
    ]);
  });

  it("removeUserWordFromList un-tags ONLY this list (scoped by list_id AND user_word_id)", async () => {
    stub.queueFrom("list_words", { data: null, error: null });
    await removeUserWordFromList({ listId: "verbs", userWordId: "uw1" });

    expect(stub.callsFor("list_words", "delete")).toHaveLength(1);
    // Both filters MUST be present — deleting by user_word_id alone would remove
    // the word from every list, not just this one.
    const eqs = stub.callsFor("list_words", "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["list_id", "verbs"]);
    expect(eqs).toContainEqual(["user_word_id", "uw1"]);
    // never touches user_words → the word stays in the vocabulary / other lists
    expect(stub.fromCalls).toEqual(["list_words"]);
  });
});

describe("getAllUserWords (the virtual ALL list)", () => {
  it("resolves each meaning (override wins, else dictionary)", async () => {
    stub.queueFrom("user_words", {
      data: [
        uwRow({ user_word_id: "a", custom_translation: null, words: { translation: "cat" } }),
        uwRow({ user_word_id: "b", dictionary_word_id: null, custom_translation: "my own", words: null }),
      ],
      error: null,
    });

    const all = await getAllUserWords({ userId: "u" });
    expect(all.map((w) => w.translation)).toEqual(["cat", "my own"]);
  });

  it("returns [] when the user has no words", async () => {
    stub.queueFrom("user_words", { data: [], error: null });
    expect(await getAllUserWords({ userId: "u" })).toEqual([]);
  });

  it("surfaces the dictionary reading, and suppresses the translation reading on override", async () => {
    stub.queueFrom("user_words", {
      data: [
        // JA→EN dictionary word: kana reading on the input side comes through.
        uwRow({
          user_word_id: "a",
          custom_translation: null,
          words: { translation: "cat", input_reading: "ねこ", translation_reading: null },
        }),
        // EN→JA word the user overrode: the dictionary's translation reading no
        // longer annotates the user's own term, so it's suppressed.
        uwRow({
          user_word_id: "b",
          input: "cat",
          source_lang: "EN",
          target_lang: "JA",
          custom_translation: "ねこちゃん",
          words: { translation: "猫", input_reading: null, translation_reading: "ねこ" },
        }),
        // Standalone created word: no dictionary row → no reading at all.
        uwRow({ user_word_id: "c", dictionary_word_id: null, custom_translation: "my own", words: null }),
      ],
      error: null,
    });

    const all = await getAllUserWords({ userId: "u" });
    expect(all).toMatchObject([
      { userWordId: "a", inputReading: "ねこ", translationReading: null },
      { userWordId: "b", translation: "ねこちゃん", translationReading: null },
      { userWordId: "c", inputReading: null, translationReading: null },
    ]);
  });
});

describe("getUserWordsInList", () => {
  it("returns the tagged words and skips dangling rows", async () => {
    stub.queueFrom("list_words", {
      data: [
        { user_words: uwRow({ user_word_id: "a", words: { translation: "cat" } }) },
        { user_words: null }, // tag whose user_word vanished
      ],
      error: null,
    });

    const entries = await getUserWordsInList({ listId: "verbs" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ userWordId: "a", translation: "cat" });
  });
});

describe("getUserWordStates", () => {
  it("marks saved dictionary senses tracked, others new (confidence 0)", async () => {
    stub.queueFrom("user_words", {
      data: [
        {
          user_word_id: "uw1",
          dictionary_word_id: "ja-neko",
          confidence_rating: 3,
          last_reviewed_date: "2026-06-01",
        },
      ],
      error: null,
    });

    const states = await getUserWordStates({ userId: "u", dictionaryWordIds: ["ja-neko", "ja-inu"] });
    expect(states.get("ja-neko")).toEqual({
      tracked: true,
      userWordId: "uw1",
      confidenceRating: 3,
      lastReviewedDate: "2026-06-01",
    });
    expect(states.get("ja-inu")).toMatchObject({ tracked: false, confidenceRating: 0 });
  });

  it("returns an entry per id without querying for no ids", async () => {
    const states = await getUserWordStates({ userId: "u", dictionaryWordIds: [] });
    expect(states.size).toBe(0);
    expect(stub.fromCalls).toEqual([]);
  });
});
