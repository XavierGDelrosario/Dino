// =========================================================
// RLS / database-enforcement integration tests  (SPEC — currently failing).
//
// These do NOT mock Supabase. They stand up TWO real authenticated users and
// assert the database itself enforces the rules the unit suite can't see through
// the mock (post per-user-vocabulary refactor):
//   - cross-user isolation: you can't read another user's user_words, or tag a
//     word into another user's list.
//   - the dictionary (`words`) is READ-ONLY to clients — no inserts at all,
//     verified or not (only the edge function / service role writes).
//
// STATUS: expected to FAIL until run against a live, migrated instance. Gated
// behind RUN_INTEGRATION so the default `npm test` (mocked, green) skips them.
// To run:
//
//   supabase start                       # local Postgres + Auth + RLS
//   VITE_SUPABASE_URL=http://localhost:54321 \
//   VITE_SUPABASE_ANON_KEY=<local-anon-key> \
//   npm run test:integration
//
// Anonymous sign-in must be enabled on the instance (it is the POC's auth mode).
// =========================================================
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Scoped declaration so this file typechecks without pulling @types/node into
// the whole project (the unit suite reads config via import.meta.env, not here).
declare const process: { env: Record<string, string | undefined> };

const URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const ANON = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
const ENABLED = process.env.RUN_INTEGRATION === "1";

interface TestUser {
  client: SupabaseClient;
  userId: string;
}

/** A fresh anonymous user with its own session and a seeded public.users row. */
async function makeUser(): Promise<TestUser> {
  // Independent client instance → independent (in-memory) session, so two users
  // can act concurrently. Not the config/supabaseClient singleton.
  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.user) throw error ?? new Error("anonymous sign-in failed");
  const userId = data.user.id;
  // lists.user_id / user_words.user_id FK requires the public.users row to exist.
  const { error: profileError } = await client
    .from("users")
    .upsert({ user_id: userId, email: `${userId}@guest.dino` }, { onConflict: "user_id" });
  if (profileError) throw profileError;
  return { client, userId };
}

/** Inserts a standalone (created) user_words row for `user`, returns its id. */
async function createUserWord(user: TestUser, customTranslation: string): Promise<string> {
  const { data, error } = await user.client
    .from("user_words")
    .insert({
      user_id: user.userId,
      input: "猫",
      source_lang: "JA",
      target_lang: "EN",
      dictionary_word_id: null,
      custom_translation: customTranslation,
    })
    .select("user_word_id")
    .single();
  if (error || !data) throw error ?? new Error("could not seed user_word");
  return (data as { user_word_id: string }).user_word_id;
}

describe.skipIf(!ENABLED)("RLS: cross-user isolation", () => {
  let alice: TestUser;
  let bob: TestUser;
  let aliceListId: string;

  beforeAll(async () => {
    alice = await makeUser();
    bob = await makeUser();

    const { data, error } = await alice.client
      .from("lists")
      .insert({ user_id: alice.userId, list_name: "alice-secret" })
      .select("list_id")
      .single();
    if (error || !data) throw error ?? new Error("could not seed Alice's list");
    aliceListId = (data as { list_id: string }).list_id;
  });

  it("Bob cannot read Alice's list", async () => {
    // EXPECT: RLS (lists: user_id = auth.uid()) hides it → empty, no error.
    const { data, error } = await bob.client
      .from("lists")
      .select("list_id")
      .eq("list_id", aliceListId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("Alice CAN read her own list (positive control)", async () => {
    const { data, error } = await alice.client
      .from("lists")
      .select("list_id")
      .eq("list_id", aliceListId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });

  it("Bob cannot read Alice's vocabulary (user_words)", async () => {
    await createUserWord(alice, "alice-private-meaning");

    // EXPECT: user_words RLS (user_id = auth.uid()) hides Alice's entries.
    const { data, error } = await bob.client
      .from("user_words")
      .select("custom_translation")
      .eq("user_id", alice.userId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("Bob cannot tag his word into Alice's list", async () => {
    const bobWordId = await createUserWord(bob, "bobs-word");

    // EXPECT: list_words RLS (parent list must be the caller's) denies the write.
    const { error } = await bob.client
      .from("list_words")
      .insert({ list_id: aliceListId, user_word_id: bobWordId });
    expect(error).not.toBeNull();
  });

  it("Bob cannot tag ALICE's word into his OWN list", async () => {
    // The reverse hole: the list is Bob's (list check passes) but the word is
    // Alice's. The WITH CHECK now also requires the user_word to be the caller's,
    // so filing someone else's word is rejected even into your own list.
    const aliceWordId = await createUserWord(alice, "alice-word-to-steal");
    const { data: bobList, error: listErr } = await bob.client
      .from("lists")
      .insert({ user_id: bob.userId, list_name: "bob-list" })
      .select("list_id")
      .single();
    expect(listErr).toBeNull();

    const { error } = await bob.client
      .from("list_words")
      .insert({
        list_id: (bobList as { list_id: string }).list_id,
        user_word_id: aliceWordId,
      });
    expect(error).not.toBeNull();
  });
});

describe.skipIf(!ENABLED)("RLS: dictionary is read-only to clients", () => {
  let user: TestUser;
  beforeAll(async () => {
    user = await makeUser();
  });

  it.each([
    ["unverified", false],
    ["verified", true],
  ])("a client cannot insert a %s dictionary word", async (_label, isVerified) => {
    // EXPECT: there is NO client INSERT policy on words — every client write is
    // rejected; only the edge function (service role) writes the dictionary.
    const { error } = await user.client.from("words").insert({
      input: "魚",
      translation: "fish",
      source_lang: "JA",
      target_lang: "EN",
      is_verified: isVerified,
    });
    expect(error).not.toBeNull();
  });

  it("a client CAN read verified dictionary words (positive control)", async () => {
    const { error } = await user.client.from("words").select("word_id").limit(1);
    expect(error).toBeNull();
  });
});

describe.skipIf(!ENABLED)("JMdict source tables are server-only", () => {
  let user: TestUser;
  beforeAll(async () => {
    user = await makeUser();
  });

  // The jmdict_* tables have RLS enabled with NO policies and NO grants, so the
  // Data API denies clients entirely — only the edge function (service role) reads
  // them. Each must be unreadable.
  it.each([
    "jmdict_entries",
    "jmdict_kanji",
    "jmdict_kana",
    "jmdict_senses",
    "jmdict_glosses",
  ])("a client cannot read %s", async (table) => {
    const { error } = await user.client.from(table).select("*").limit(1);
    expect(error).not.toBeNull(); // permission denied (no grant)
  });
});

describe.skipIf(!ENABLED)("sub-list membership: multi-list + scoped removal", () => {
  let user: TestUser;
  let listA: string;
  let listB: string;
  let wordId: string;

  const makeList = async (u: TestUser, name: string): Promise<string> => {
    const { data, error } = await u.client
      .from("lists")
      .insert({ user_id: u.userId, list_name: name })
      .select("list_id")
      .single();
    if (error || !data) throw error ?? new Error("list seed failed");
    return (data as { list_id: string }).list_id;
  };

  beforeAll(async () => {
    user = await makeUser();
    wordId = await createUserWord(user, "membership-test");
    listA = await makeList(user, "A");
    listB = await makeList(user, "B");
    const { error } = await user.client.from("list_words").insert([
      { list_id: listA, user_word_id: wordId },
      { list_id: listB, user_word_id: wordId },
    ]);
    if (error) throw error;
  });

  it("a word can live in two sub-lists at once", async () => {
    const { data, error } = await user.client
      .from("list_words")
      .select("list_id")
      .eq("user_word_id", wordId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(2);
  });

  it("removing it from list A leaves it in list B and in the vocabulary", async () => {
    const del = await user.client
      .from("list_words")
      .delete()
      .eq("list_id", listA)
      .eq("user_word_id", wordId);
    expect(del.error).toBeNull();

    const inB = await user.client
      .from("list_words")
      .select("list_id")
      .eq("list_id", listB)
      .eq("user_word_id", wordId);
    expect(inB.data ?? []).toHaveLength(1); // still tagged in B

    const inA = await user.client
      .from("list_words")
      .select("list_id")
      .eq("list_id", listA)
      .eq("user_word_id", wordId);
    expect(inA.data ?? []).toHaveLength(0); // gone from A only

    const vocab = await user.client
      .from("user_words")
      .select("user_word_id")
      .eq("user_word_id", wordId);
    expect(vocab.data ?? []).toHaveLength(1); // still in the vocabulary
  });
});
