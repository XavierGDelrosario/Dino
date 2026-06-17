import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as any } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import { saveWordToUserLibrary, removeWordFromList } from "@/services/words/userLibrary";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
});

/** Queue the ALL-list lookup (getOrCreateAllListId hits `lists` first). */
function queueAllList(allId = "all-1") {
  stub.queueFrom("lists", { data: { list_id: allId }, error: null });
}

describe("saveWordToUserLibrary", () => {
  it("reports isNewForUser=true and links the word into ALL", async () => {
    queueAllList("all-1");
    stub.queueFrom("list_words", { data: [], error: null }); // before-snapshot: not present
    stub.queueFrom("user_word_mastery", { data: null, error: null }); // mastery upsert
    stub.queueFrom("list_words", { data: null, error: null }); // link upsert

    const res = await saveWordToUserLibrary({ userId: "u", wordId: "w1" });

    expect(res).toEqual({ isNewForUser: true });
    // ensures a mastery row...
    const mastery = stub.callsFor("user_word_mastery", "upsert")[0];
    expect(mastery?.args[0]).toEqual({ user_id: "u", word_id: "w1" });
    // ...and links into the ALL list.
    const link = stub.callsFor("list_words", "upsert")[0];
    expect(link?.args[0]).toEqual([{ list_id: "all-1", word_id: "w1" }]);
  });

  it("reports isNewForUser=false when already in ALL", async () => {
    queueAllList("all-1");
    stub.queueFrom("list_words", { data: [{ list_id: "all-1", word_id: "w1" }], error: null });
    stub.queueFrom("user_word_mastery", { data: null, error: null });
    stub.queueFrom("list_words", { data: null, error: null });

    const res = await saveWordToUserLibrary({ userId: "u", wordId: "w1" });
    expect(res).toEqual({ isNewForUser: false });
  });

  it("also links into a provided target list (ALL + target)", async () => {
    queueAllList("all-1");
    stub.queueFrom("list_words", { data: [], error: null });
    stub.queueFrom("user_word_mastery", { data: null, error: null });
    stub.queueFrom("list_words", { data: null, error: null });

    await saveWordToUserLibrary({ userId: "u", wordId: "w1", listId: "verbs" });

    const link = stub.callsFor("list_words", "upsert")[0];
    expect(link?.args[0]).toEqual([
      { list_id: "all-1", word_id: "w1" },
      { list_id: "verbs", word_id: "w1" },
    ]);
  });

  it("does not double-link when the target list IS the ALL list", async () => {
    queueAllList("all-1");
    stub.queueFrom("list_words", { data: [], error: null });
    stub.queueFrom("user_word_mastery", { data: null, error: null });
    stub.queueFrom("list_words", { data: null, error: null });

    await saveWordToUserLibrary({ userId: "u", wordId: "w1", listId: "all-1" });

    const link = stub.callsFor("list_words", "upsert")[0];
    expect(link?.args[0]).toEqual([{ list_id: "all-1", word_id: "w1" }]);
  });
});

describe("removeWordFromList", () => {
  it("deletes only the list_words link", async () => {
    stub.queueFrom("list_words", { data: null, error: null });
    await expect(
      removeWordFromList({ listId: "verbs", wordId: "w1" })
    ).resolves.toBeUndefined();
    expect(stub.callsFor("list_words", "delete")).toHaveLength(1);
    // never touches words or mastery
    expect(stub.fromCalls).toEqual(["list_words"]);
  });
});
