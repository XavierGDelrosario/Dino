// =========================================================
// RLS / database-enforcement integration tests  (SPEC — currently failing).
//
// These do NOT mock Supabase. They stand up TWO real authenticated users and
// assert the database itself enforces the security rules the unit suite can't
// see through the mock:
//   - cross-user isolation (you can't read/write another user's rows)
//   - the client can NEVER write is_verified = true (only the edge function can)
//
// STATUS: expected to FAIL until run against a live, migrated instance. They are
// gated behind RUN_INTEGRATION so the default `npm test` (mocked, green) skips
// them. To run them:
//
//   supabase start                       # local Postgres + Auth + RLS
//   # then point env at it (the anon key is printed by `supabase start`):
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
  // words.created_by / lists.user_id FK requires the public.users row to exist.
  const { error: profileError } = await client
    .from("users")
    .upsert({ user_id: userId, email: `${userId}@guest.dino` }, { onConflict: "user_id" });
  if (profileError) throw profileError;
  return { client, userId };
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
      .select("list_id, list_name")
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

  it("Bob cannot link a word into Alice's list", async () => {
    // Seed a word Bob legitimately owns (unverified), then try to attach it to
    // Alice's list_id. EXPECT: RLS on list_words rejects the write.
    const { data: word, error: wErr } = await bob.client
      .from("words")
      .upsert(
        {
          input: "犬",
          translation: "dog",
          source_lang: "JA",
          target_lang: "EN",
          is_verified: false,
          created_by: bob.userId,
        },
        { onConflict: "input,translation,source_lang,target_lang,created_by,is_verified" }
      )
      .select("word_id")
      .single();
    expect(wErr).toBeNull();

    const { error } = await bob.client
      .from("list_words")
      .insert({ list_id: aliceListId, word_id: (word as { word_id: string }).word_id });
    expect(error).not.toBeNull(); // write into another user's list must be denied
  });

  it("Bob cannot read Alice's unverified word", async () => {
    // Alice saves a private (unverified) custom word.
    const { error: aErr } = await alice.client.from("words").upsert(
      {
        input: "猫",
        translation: "alice-private-meaning",
        source_lang: "JA",
        target_lang: "EN",
        is_verified: false,
        created_by: alice.userId,
      },
      { onConflict: "input,translation,source_lang,target_lang,created_by,is_verified" }
    );
    expect(aErr).toBeNull();

    // EXPECT: RLS shows verified rows + the caller's OWN unverified rows only,
    // so Bob never sees Alice's unverified meaning.
    const { data, error } = await bob.client
      .from("words")
      .select("translation")
      .eq("input", "猫")
      .eq("is_verified", false);
    expect(error).toBeNull();
    const translations = (data ?? []).map((r) => (r as { translation: string }).translation);
    expect(translations).not.toContain("alice-private-meaning");
  });

  it("Bob cannot read Alice's mastery rows", async () => {
    const { data, error } = await bob.client
      .from("user_word_mastery")
      .select("word_id")
      .eq("user_id", alice.userId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});

describe.skipIf(!ENABLED)("RLS: is_verified is server-only", () => {
  let user: TestUser;
  beforeAll(async () => {
    user = await makeUser();
  });

  it("a client cannot insert a verified word", async () => {
    // EXPECT: the WITH CHECK policy forbids is_verified = true from clients;
    // only the edge function (service role) may promote to the global dict.
    const { error } = await user.client.from("words").insert({
      input: "魚",
      translation: "fish",
      source_lang: "JA",
      target_lang: "EN",
      is_verified: true, // <- the forbidden bit
      created_by: user.userId,
    });
    expect(error).not.toBeNull();
  });
});
