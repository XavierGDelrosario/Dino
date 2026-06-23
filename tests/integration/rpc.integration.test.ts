// =========================================================
// SQL / Postgres FUNCTION integration tests (LIVE — needs a migrated DB).
//
// The default Vitest suite mocks Supabase, so it can only assert the *arguments*
// passed to `.rpc(...)`, never the PL/pgSQL behaviour. These call the functions
// for real against a live Postgres and assert what they DO — the body logic that
// was previously "verified manually" only:
//   save_dictionary_word · create_custom_word · record_review · jmdict_lookup ·
//   consume_translation_quota
//
// Gated behind RUN_INTEGRATION. The service-role blocks self-skip without
// SUPABASE_SERVICE_ROLE_KEY (they seed `words` / call service-role-only funcs).
// To run:
//   supabase start
//   VITE_SUPABASE_URL=http://127.0.0.1:54321 \
//   VITE_SUPABASE_ANON_KEY=<local-anon-key> \
//   SUPABASE_SERVICE_ROLE_KEY=<local-service-role-key> \
//   npm run test:integration
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

// ── create_custom_word (anon-callable) ─────────────────────────────────────
describe.skipIf(!ENABLED)("rpc: create_custom_word", () => {
  it("creates a standalone word (custom_translation set, no dictionary ref)", async () => {
    const u = await makeUser();
    const { data, error } = await u.client.rpc("create_custom_word", {
      p_user_id: u.userId,
      p_input: "いぬ",
      p_translation: "doggo",
      p_source: "JA",
      p_target: "EN",
    });
    expect(error).toBeNull();
    const row = data as { custom_translation: string; dictionary_word_id: string | null };
    expect(row.custom_translation).toBe("doggo");
    expect(row.dictionary_word_id).toBeNull();
  });

  it("idempotent re-create returns the SAME row (the unique-violation catch+refetch)", async () => {
    const u = await makeUser();
    const args = {
      p_user_id: u.userId,
      p_input: "ねこ",
      p_translation: "kitty",
      p_source: "JA",
      p_target: "EN",
    };
    const first = await u.client.rpc("create_custom_word", args);
    const second = await u.client.rpc("create_custom_word", args);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect((second.data as { user_word_id: string }).user_word_id).toBe(
      (first.data as { user_word_id: string }).user_word_id,
    );
    // Exactly one row exists for the pair (no duplicate).
    const { data: rows } = await u.client
      .from("user_words")
      .select("user_word_id")
      .eq("input", "ねこ");
    expect(rows ?? []).toHaveLength(1);
  });

  it("tags an optional sub-list atomically", async () => {
    const u = await makeUser();
    const listId = await makeList(u, "MyWords");
    const { data, error } = await u.client.rpc("create_custom_word", {
      p_user_id: u.userId,
      p_input: "とり",
      p_translation: "birb",
      p_source: "JA",
      p_target: "EN",
      p_list_id: listId,
    });
    expect(error).toBeNull();
    const { data: tags } = await u.client
      .from("list_words")
      .select("list_id")
      .eq("user_word_id", (data as { user_word_id: string }).user_word_id);
    expect((tags ?? []).map((t) => (t as { list_id: string }).list_id)).toEqual([listId]);
  });
});

// ── record_review (anon-callable, SECURITY DEFINER) ────────────────────────
describe.skipIf(!ENABLED)("rpc: record_review", () => {
  it("first review seeds stability from the grade + appends a review_log row", async () => {
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "学ぶ", meaning: "to learn" });
    const { data, error } = await u.client.rpc("record_review", {
      p_user_word_id: w,
      p_grade: 5,
    });
    expect(error).toBeNull();
    const row = data as { stability: number; confidence_rating: number; last_reviewed_date: string };
    expect(row.stability).toBeCloseTo(7.0, 5); // grade 5 seed
    expect(row.confidence_rating).toBe(3); // 7.0 → bucket <16
    expect(row.last_reviewed_date).not.toBeNull();

    const { data: log } = await u.client
      .from("review_log")
      .select("grade, new_stability")
      .eq("user_word_id", w);
    expect(log ?? []).toHaveLength(1);
    expect((log![0] as { grade: number }).grade).toBe(5);
  });

  it("a lapse (grade 1) after a strong review shrinks stability", async () => {
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "覚える", meaning: "to memorize" });
    await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 5 }); // stability 7.0
    const { data } = await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 1 });
    const row = data as { stability: number; confidence_rating: number };
    expect(row.stability).toBeCloseTo(2.1, 1); // 7.0 * 0.3 lapse factor
    expect(row.confidence_rating).toBe(1); // 2.1 → bucket <3
    const { data: log } = await u.client.from("review_log").select("grade").eq("user_word_id", w);
    expect(log ?? []).toHaveLength(2); // append-only: two rows
  });

  it("rejects an invalid grade", async () => {
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "x", meaning: "m" });
    const { error } = await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 6 });
    expect(error).not.toBeNull();
  });

  it("cannot review another user's word (SECURITY DEFINER ownership guard)", async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const aliceWord = await makeStandaloneWord(alice, { input: "秘密", meaning: "secret" });
    // Bob knows the id but the function scopes to auth.uid() → NOT FOUND.
    const { error } = await bob.client.rpc("record_review", {
      p_user_word_id: aliceWord,
      p_grade: 5,
    });
    expect(error).not.toBeNull();
    // And Alice's word was untouched.
    const { data } = await alice.client
      .from("user_words")
      .select("stability")
      .eq("user_word_id", aliceWord)
      .single();
    expect((data as { stability: number | null }).stability).toBeNull();
  });
});

// ── save_dictionary_word (needs a service-role-seeded verified `words` row) ──
describe.skipIf(!ENABLED || !SERVICE_KEY)("rpc: save_dictionary_word", () => {
  it("saves a verified sense into the vocabulary (idempotent) deriving input/langs, tagging a list", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const input = `__rpc_save_${Date.now()}__`;
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
    const wordId = (seeded.data as { word_id: string }).word_id;

    const u = await makeUser();
    const listId = await makeList(u, "Saved");
    const first = await u.client.rpc("save_dictionary_word", {
      p_user_id: u.userId,
      p_dictionary_word_id: wordId,
      p_list_id: listId,
    });
    expect(first.error).toBeNull();
    const row = first.data as {
      user_word_id: string;
      input: string;
      source_lang: string;
      dictionary_word_id: string;
      custom_translation: string | null;
    };
    expect(row.input).toBe(input); // derived from the words row, not passed
    expect(row.source_lang).toBe("JA");
    expect(row.dictionary_word_id).toBe(wordId);
    expect(row.custom_translation).toBeNull();

    // tagged atomically
    const { data: tags } = await u.client
      .from("list_words")
      .select("list_id")
      .eq("user_word_id", row.user_word_id);
    expect((tags ?? []).map((t) => (t as { list_id: string }).list_id)).toEqual([listId]);

    // idempotent re-save → same row, no duplicate
    const second = await u.client.rpc("save_dictionary_word", {
      p_user_id: u.userId,
      p_dictionary_word_id: wordId,
    });
    expect((second.data as { user_word_id: string }).user_word_id).toBe(row.user_word_id);
    const { data: rows } = await u.client
      .from("user_words")
      .select("user_word_id")
      .eq("dictionary_word_id", wordId);
    expect(rows ?? []).toHaveLength(1);
  });
});

// ── save_dictionary_words (BATCH; needs service-role-seeded verified rows) ──
describe.skipIf(!ENABLED || !SERVICE_KEY)("rpc: save_dictionary_words", () => {
  it("saves many senses in one call, tags them all, and is idempotent", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const stamp = Date.now();
    const seed = async (input: string, translation: string) => {
      const { data, error } = await svc
        .from("words")
        .insert({ input, translation, source_lang: "JA", target_lang: "EN", is_verified: true })
        .select("word_id")
        .single();
      expect(error).toBeNull();
      return (data as { word_id: string }).word_id;
    };
    const idA = await seed(`__batch_a_${stamp}__`, "alpha");
    const idB = await seed(`__batch_b_${stamp}__`, "beta");

    const u = await makeUser();
    const listId = await makeList(u, "Batch");
    const first = await u.client.rpc("save_dictionary_words", {
      p_user_id: u.userId,
      p_dictionary_word_ids: [idA, idB],
      p_list_id: listId,
    });
    expect(first.error).toBeNull();
    const rows = first.data as { user_word_id: string; dictionary_word_id: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dictionary_word_id).sort()).toEqual([idA, idB].sort());

    // all tagged into the list atomically
    const { data: tags } = await u.client
      .from("list_words")
      .select("user_word_id")
      .eq("list_id", listId);
    expect(tags ?? []).toHaveLength(2);

    // idempotent re-save of the same set → no duplicate user_words rows
    const second = await u.client.rpc("save_dictionary_words", {
      p_user_id: u.userId,
      p_dictionary_word_ids: [idA, idB],
    });
    expect(second.error).toBeNull();
    const { data: all } = await u.client
      .from("user_words")
      .select("user_word_id")
      .in("dictionary_word_id", [idA, idB]);
    expect(all ?? []).toHaveLength(2);
  });

  it("silently skips an unknown/unverified id instead of failing the batch", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const { data, error } = await svc
      .from("words")
      .insert({ input: `__batch_ok_${Date.now()}__`, translation: "ok", source_lang: "JA", target_lang: "EN", is_verified: true })
      .select("word_id")
      .single();
    expect(error).toBeNull();
    const goodId = (data as { word_id: string }).word_id;
    const bogusId = "00000000-0000-0000-0000-000000000000";

    const u = await makeUser();
    const res = await u.client.rpc("save_dictionary_words", {
      p_user_id: u.userId,
      p_dictionary_word_ids: [goodId, bogusId],
    });
    expect(res.error).toBeNull();
    const rows = res.data as { dictionary_word_id: string }[];
    expect(rows.map((r) => r.dictionary_word_id)).toEqual([goodId]); // bogus dropped
  });
});

// ── review_queue (anon-callable; ranking + LIMIT in SQL) ────────────────────
describe.skipIf(!ENABLED)("rpc: review_queue", () => {
  it("ranks least-confident first and respects the limit", async () => {
    const u = await makeUser();
    // never-reviewed (R=0) + a strong one (R≈1). Both standalone words.
    const fresh = await makeStandaloneWord(u, { input: "新出", meaning: "new word" });
    const strong = await makeStandaloneWord(u, { input: "得意", meaning: "strong word" });
    await u.client.rpc("record_review", { p_user_word_id: strong, p_grade: 5 }); // stability 7, R≈1

    const { data, error } = await u.client.rpc("review_queue", {
      p_user_id: u.userId,
      p_limit: 10,
    });
    expect(error).toBeNull();
    const queue = data as { user_word_id: string; retrievability: number; translation: string }[];
    expect(queue[0].user_word_id).toBe(fresh); // R=0 sorts first
    expect(queue[0].retrievability).toBe(0);
    expect(queue[0].translation).toBe("new word"); // resolved meaning rides along
    // the strong word is present but ranked after the fresh one
    expect(queue.find((q) => q.user_word_id === strong)!.retrievability).toBeGreaterThan(0.9);

    const limited = await u.client.rpc("review_queue", { p_user_id: u.userId, p_limit: 1 });
    expect((limited.data as unknown[]).length).toBe(1);
  });

  it("scopes to a sub-list when p_list_id is given", async () => {
    const u = await makeUser();
    const inList = await makeStandaloneWord(u, { input: "範囲内", meaning: "in list" });
    await makeStandaloneWord(u, { input: "範囲外", meaning: "not in list" });
    const listId = await makeList(u, "Scoped");
    await u.client.from("list_words").insert({ list_id: listId, user_word_id: inList });

    const { data, error } = await u.client.rpc("review_queue", {
      p_user_id: u.userId,
      p_limit: 10,
      p_list_id: listId,
    });
    expect(error).toBeNull();
    const queue = data as { user_word_id: string }[];
    expect(queue.map((q) => q.user_word_id)).toEqual([inList]); // only the tagged word
  });

  it("cannot see another user's words (RLS)", async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    await makeStandaloneWord(alice, { input: "内緒", meaning: "private" });
    // Bob passing Alice's id still only sees his own rows (RLS on user_words).
    const { data } = await bob.client.rpc("review_queue", {
      p_user_id: alice.userId,
      p_limit: 10,
    });
    expect((data as unknown[]) ?? []).toHaveLength(0);
  });
});

// ── jmdict_lookup (service-role only) ──────────────────────────────────────
describe.skipIf(!ENABLED || !SERVICE_KEY)("rpc: jmdict_lookup", () => {
  it("is NOT callable by a client (no EXECUTE grant)", async () => {
    const u = await makeUser();
    const { error } = await u.client.rpc("jmdict_lookup", {
      p_input: "猫",
      p_source: "JA",
      p_target: "EN",
    });
    expect(error).not.toBeNull(); // permission denied — server-only
  });

  it("returns senses for a loaded JA entry (skips if JMdict not ingested)", async () => {
    const svc = serviceClient();
    if (!svc) return;
    // Use whatever's loaded so the test doesn't depend on a specific word.
    const { data: kanji } = await svc.from("jmdict_kanji").select("text").limit(1);
    if (!kanji || kanji.length === 0) {
      // JMdict source not ingested in this environment — nothing to look up.
      return;
    }
    const term = (kanji[0] as { text: string }).text;
    const { data, error } = await svc.rpc("jmdict_lookup", {
      p_input: term,
      p_source: "JA",
      p_target: "EN",
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ translation: string; writing: string; jmdict_entry_id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].translation).toBeTruthy();
    expect(rows[0].jmdict_entry_id).toBeTruthy();
  });
});

// ── consume_translation_quota (service-role only) ──────────────────────────
describe.skipIf(!ENABLED || !SERVICE_KEY)("rpc: consume_translation_quota", () => {
  it("is NOT callable by a client (no EXECUTE grant)", async () => {
    const u = await makeUser();
    const { error } = await u.client.rpc("consume_translation_quota", {
      p_user_id: u.userId,
      p_chars: 10,
      p_quota: 100,
    });
    expect(error).not.toBeNull();
  });

  it("reserves within quota and atomically denies over quota", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const u = await makeUser(); // creates the public.users row the FK needs
    const quota = 25;
    const call = (chars: number) =>
      svc.rpc("consume_translation_quota", { p_user_id: u.userId, p_chars: chars, p_quota: quota });

    const one = await call(10); // 0+10 ≤ 25 → allowed, used 10
    const two = await call(10); // 10+10 ≤ 25 → allowed, used 20
    const three = await call(10); // 20+10 > 25 → DENIED, used stays 20

    const r = (x: { data: unknown }) => (Array.isArray(x.data) ? x.data[0] : x.data) as {
      allowed: boolean;
      used: number;
    };
    expect(r(one)).toEqual({ allowed: true, used: 10 });
    expect(r(two)).toEqual({ allowed: true, used: 20 });
    expect(r(three)).toEqual({ allowed: false, used: 20 }); // no increment on denial

    // The persisted total reflects only the allowed reservations.
    const { data: usage } = await svc
      .from("translation_usage")
      .select("chars_used")
      .eq("user_id", u.userId);
    expect((usage![0] as { chars_used: number }).chars_used).toBe(20);
  });
});
