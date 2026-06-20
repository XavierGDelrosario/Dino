// =========================================================
// DB-constraint + multi-language enforcement tests (LIVE — needs a migrated DB).
//
// The default Vitest suite mocks Supabase, so it can only assert app-side INTENT
// (e.g. the client SENDS is_verified:false), never that the DATABASE rejects a
// violation. These do the opposite: they hit a real Postgres and assert the
// schema's UNIQUE / CHECK / FK / cascade rules — and that the model stores and
// keys non-Latin (Japanese/Korean/Chinese) vocabulary correctly.
//
// Companion to rls.integration.test.ts (cross-user RLS). Gated behind
// RUN_INTEGRATION so the default `npm test` skips it. To run:
//
//   supabase start
//   VITE_SUPABASE_URL=http://127.0.0.1:54321 \
//   VITE_SUPABASE_ANON_KEY=<local-anon-key> \
//   SUPABASE_SERVICE_ROLE_KEY=<local-service-role-key> \   # optional (one block)
//   npm run test:integration
//
// Error codes asserted are Postgres SQLSTATEs surfaced by PostgREST:
//   23505 unique_violation · 23503 foreign_key_violation · 23514 check_violation
// =========================================================
import { describe, it, expect } from "vitest";
import {
  ENABLED,
  SERVICE_KEY,
  makeList,
  makeStandaloneWord,
  makeUser,
  serviceClient,
} from "./_support";

const FAKE_UUID = "00000000-0000-0000-0000-0000000000ff";

describe.skipIf(!ENABLED)("DB constraints: UNIQUE", () => {
  it("a user cannot create two sub-lists with the same name (lists user_id, list_name)", async () => {
    const u = await makeUser();
    await makeList(u, "dupe");
    const { error } = await u.client
      .from("lists")
      .insert({ user_id: u.userId, list_name: "dupe" });
    expect(error?.code).toBe("23505");
  });

  it("the same word cannot be tagged into one list twice (list_words list_id, user_word_id)", async () => {
    const u = await makeUser();
    const list = await makeList(u, "L");
    const w = await makeStandaloneWord(u, { input: "猫", meaning: "cat" });
    const first = await u.client.from("list_words").insert({ list_id: list, user_word_id: w });
    expect(first.error).toBeNull();
    const second = await u.client.from("list_words").insert({ list_id: list, user_word_id: w });
    expect(second.error?.code).toBe("23505");
  });

  it("a user cannot create the same standalone word+meaning twice (uq_user_words_custom)", async () => {
    const u = await makeUser();
    await makeStandaloneWord(u, { input: "犬", meaning: "dog" });
    const { error } = await u.client.from("user_words").insert({
      user_id: u.userId,
      input: "犬",
      source_lang: "JA",
      target_lang: "EN",
      dictionary_word_id: null,
      custom_translation: "dog",
    });
    expect(error?.code).toBe("23505");
  });

  it("two users cannot share an email (users.email UNIQUE)", async () => {
    const a = await makeUser();
    const b = await makeUser();
    // b owns its row (RLS passes), but claiming a's email hits the UNIQUE index.
    const { error } = await b.client
      .from("users")
      .update({ email: `${a.userId}@guest.dino` })
      .eq("user_id", b.userId);
    expect(error?.code).toBe("23505");
  });
});

describe.skipIf(!ENABLED)("DB constraints: NULL-distinctness allows homograph created words", () => {
  it("the same surface form with DIFFERENT meanings can both be created (辛い→からい/つらい-style)", async () => {
    // uq_user_words_custom is partial (WHERE dictionary_word_id IS NULL) and keyed
    // on custom_translation too, so two senses of one homograph coexist.
    const u = await makeUser();
    const spicy = await makeStandaloneWord(u, { input: "辛い", meaning: "spicy" });
    const painful = await makeStandaloneWord(u, { input: "辛い", meaning: "painful" });
    expect(spicy).not.toEqual(painful);
    const { data } = await u.client
      .from("user_words")
      .select("user_word_id")
      .eq("input", "辛い");
    expect(data ?? []).toHaveLength(2);
  });
});

describe.skipIf(!ENABLED)("DB constraints: CHECK", () => {
  it("a user_word with neither a dictionary ref nor a custom meaning is rejected (user_words_has_meaning)", async () => {
    const u = await makeUser();
    const { error } = await u.client.from("user_words").insert({
      user_id: u.userId,
      input: "x",
      source_lang: "JA",
      target_lang: "EN",
      dictionary_word_id: null,
      custom_translation: null,
    });
    expect(error?.code).toBe("23514");
  });

  it("confidence_rating outside 0–5 is rejected", async () => {
    const u = await makeUser();
    const { error } = await u.client.from("user_words").insert({
      user_id: u.userId,
      input: "y",
      source_lang: "JA",
      target_lang: "EN",
      custom_translation: "m",
      confidence_rating: 9,
    });
    expect(error?.code).toBe("23514");
  });

  // NOTE: review_log's grade CHECK (1–5) still exists, but it's no longer
  // client-reachable — clients can't INSERT review_log at all (see below); the
  // grade is validated inside record_review() before the insert.
});

describe.skipIf(!ENABLED)("review_log is append-only via record_review (no client writes)", () => {
  it("a client cannot write review_log directly (FSRS history can't be forged)", async () => {
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "z", meaning: "m" });
    // No client INSERT grant — writes go only through the SECURITY DEFINER
    // record_review(). A client therefore can't fabricate review rows.
    const { error } = await u.client.from("review_log").insert({
      user_word_id: w,
      user_id: u.userId,
      grade: 3,
      new_stability: 1.0,
    });
    expect(error).not.toBeNull();
  });
});

describe.skipIf(!ENABLED)("DB constraints: foreign keys", () => {
  it("tagging a nonexistent/non-owned user_word into one's own list is rejected (RLS guards the FK)", async () => {
    const u = await makeUser();
    const list = await makeList(u, "L");
    // The tightened list_words WITH CHECK requires the user_word to be the
    // caller's, so a dangling id is denied by RLS (42501) BEFORE the FK to
    // user_words (23503) — which remains the deeper backstop — would fire.
    const { error } = await u.client
      .from("list_words")
      .insert({ list_id: list, user_word_id: FAKE_UUID });
    expect(error?.code).toBe("42501");
  });

  it("a user_word referencing a nonexistent dictionary sense violates the FK", async () => {
    const u = await makeUser();
    const { error } = await u.client.from("user_words").insert({
      user_id: u.userId,
      input: "q",
      source_lang: "JA",
      target_lang: "EN",
      dictionary_word_id: FAKE_UUID,
      custom_translation: "m",
    });
    expect(error?.code).toBe("23503");
  });
});

describe.skipIf(!ENABLED)("DB cascade: deleting a word vs deleting a list", () => {
  it("deleting a user_word removes its list tags but leaves the list (list_words cascade)", async () => {
    const u = await makeUser();
    const list = await makeList(u, "L");
    const w = await makeStandaloneWord(u, { input: "魚", meaning: "fish" });
    await u.client.from("list_words").insert({ list_id: list, user_word_id: w });

    const del = await u.client.from("user_words").delete().eq("user_word_id", w);
    expect(del.error).toBeNull();

    const tags = await u.client.from("list_words").select("list_word_id").eq("user_word_id", w);
    expect(tags.data ?? []).toHaveLength(0); // tag cascaded away
    const listStill = await u.client.from("lists").select("list_id").eq("list_id", list);
    expect(listStill.data ?? []).toHaveLength(1); // the sub-list survives
  });

  it("deleting a sub-list removes its tags but leaves the word in the vocabulary (ALL stays)", async () => {
    const u = await makeUser();
    const list = await makeList(u, "L2");
    const w = await makeStandaloneWord(u, { input: "鳥", meaning: "bird" });
    await u.client.from("list_words").insert({ list_id: list, user_word_id: w });

    const del = await u.client.from("lists").delete().eq("list_id", list);
    expect(del.error).toBeNull();

    const tags = await u.client.from("list_words").select("list_word_id").eq("user_word_id", w);
    expect(tags.data ?? []).toHaveLength(0); // tag cascaded away
    const wordStill = await u.client.from("user_words").select("user_word_id").eq("user_word_id", w);
    expect(wordStill.data ?? []).toHaveLength(1); // word remains in the user's vocabulary
  });
});

describe.skipIf(!ENABLED)("multi-language: non-Latin storage + per-pair identity", () => {
  // The user-facing model (words / user_words) is language-agnostic: source_lang /
  // target_lang are free-form TEXT and inputs are UTF-8 TEXT, so Korean (Hangul)
  // and Chinese (Hanzi) are first-class — Japanese-specificity lives only in the
  // jmdict_* SOURCE tables, not here.
  it("stores and reads back Korean and Chinese vocabulary verbatim", async () => {
    const u = await makeUser();
    const ko = await makeStandaloneWord(u, {
      input: "사랑",
      source: "KO",
      target: "EN",
      meaning: "love",
    });
    const zh = await makeStandaloneWord(u, {
      input: "爱",
      source: "ZH",
      target: "EN",
      meaning: "love",
    });
    const { data, error } = await u.client
      .from("user_words")
      .select("input")
      .in("user_word_id", [ko, zh]);
    expect(error).toBeNull();
    const inputs = (data ?? []).map((r) => (r as { input: string }).input).sort();
    expect(inputs).toEqual(["사랑", "爱"].sort());
  });

  it("the same surface form in DIFFERENT language pairs is two distinct entries (lang is part of identity)", async () => {
    // 愛 is a word in both JA and ZH; with identical meaning the rows differ ONLY
    // by source_lang — both must persist, proving language participates in the
    // uniqueness key (they don't collapse into one).
    const u = await makeUser();
    const ja = await makeStandaloneWord(u, { input: "愛", source: "JA", target: "EN", meaning: "love" });
    const zh = await makeStandaloneWord(u, { input: "愛", source: "ZH", target: "EN", meaning: "love" });
    expect(ja).not.toEqual(zh);
    const { data } = await u.client.from("user_words").select("source_lang").eq("input", "愛");
    expect((data ?? []).map((r) => (r as { source_lang: string }).source_lang).sort()).toEqual([
      "JA",
      "ZH",
    ]);
  });
});

// Needs a verified `words` row, which only the service role can seed — so this
// block self-skips when no service-role key is provided.
describe.skipIf(!ENABLED || !SERVICE_KEY)("DB constraints needing a dictionary sense (service-role seeded)", () => {
  it("a dictionary sense can be saved into a user's vocabulary only once (uq_user_words_dictionary)", async () => {
    const svc = serviceClient();
    if (!svc) return; // type-narrowing; the skipIf already guards this
    // Seed a verified dictionary sense (unique input avoids cross-run collisions).
    const input = `__test_uniq_${Date.now()}__`;
    const seeded = await svc
      .from("words")
      .insert({
        input,
        translation: "fish",
        source_lang: "JA",
        target_lang: "EN",
        is_verified: true,
        input_reading: "さかな",
      })
      .select("word_id")
      .single();
    expect(seeded.error).toBeNull();
    const dictionaryWordId = (seeded.data as { word_id: string }).word_id;

    const u = await makeUser();
    const first = await u.client.from("user_words").insert({
      user_id: u.userId,
      input,
      source_lang: "JA",
      target_lang: "EN",
      dictionary_word_id: dictionaryWordId,
      custom_translation: null,
    });
    expect(first.error).toBeNull();

    const second = await u.client.from("user_words").insert({
      user_id: u.userId,
      input,
      source_lang: "JA",
      target_lang: "EN",
      dictionary_word_id: dictionaryWordId,
      custom_translation: null,
    });
    expect(second.error?.code).toBe("23505"); // same (user, sense) rejected
  });
});

describe.skipIf(!ENABLED)("user_limits: read-own, no client writes (can't self-raise a restriction)", () => {
  it("a user can READ their own limits (empty until an admin/service role sets one)", async () => {
    const u = await makeUser();
    const { error } = await u.client
      .from("user_limits")
      .select("paragraph_char_limit")
      .eq("user_id", u.userId);
    expect(error).toBeNull(); // SELECT is allowed (RLS own-row); no row yet → defaults apply in app
  });

  it("a user CANNOT write their own limits (no client write grant/policy)", async () => {
    const u = await makeUser();
    // The whole point of restrictions: a client must not be able to grant itself
    // a higher cap. Only the service role writes user_limits.
    const { error } = await u.client
      .from("user_limits")
      .insert({ user_id: u.userId, paragraph_char_limit: 999999 });
    expect(error).not.toBeNull();
  });

  it("a user can READ but CANNOT write their translation_usage (no faking/reset)", async () => {
    const u = await makeUser();
    const read = await u.client
      .from("translation_usage")
      .select("chars_used")
      .eq("user_id", u.userId);
    expect(read.error).toBeNull(); // own usage is readable (for a "X/quota" display)

    // Resetting/inflating usage would defeat the quota — only the service role writes.
    const write = await u.client
      .from("translation_usage")
      .insert({ user_id: u.userId, period_month: "2026-06-01", chars_used: 0 });
    expect(write.error).not.toBeNull();
  });
});
