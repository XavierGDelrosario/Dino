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

// ── cold-start seeding (#10): the p_initial_stability path ──────────────────
describe.skipIf(!ENABLED || !SERVICE_KEY)("rpc: save_dictionary_word cold-start seed", () => {
  it("seeds a NEW row's stability + derived confidence, but never clobbers an existing one", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const input = `__seed_${Date.now()}__`;
    const seeded = await svc
      .from("words")
      .insert({ input, translation: "x", source_lang: "JA", target_lang: "EN", is_verified: true })
      .select("word_id")
      .single();
    const wordId = (seeded.data as { word_id: string }).word_id;

    const u = await makeUser();
    // First save WITH a seed → new row starts at stability 5, confidence bucket(5)=2.
    const first = await u.client.rpc("save_dictionary_word", {
      p_user_id: u.userId,
      p_dictionary_word_id: wordId,
      p_initial_stability: 5,
    });
    expect(first.error).toBeNull();
    const row = first.data as { user_word_id: string; stability: number; confidence_rating: number };
    expect(row.stability).toBeCloseTo(5, 5);
    expect(row.confidence_rating).toBe(2); // 3 ≤ 5 < 7

    // Re-save with a DIFFERENT seed → existing row's stability is preserved.
    const again = await u.client.rpc("save_dictionary_word", {
      p_user_id: u.userId,
      p_dictionary_word_id: wordId,
      p_initial_stability: 30,
    });
    expect((again.data as { stability: number }).stability).toBeCloseTo(5, 5); // unchanged
  });

  it("omitting the seed cold-starts (stability NULL, confidence 0) — back-compat", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const input = `__noseed_${Date.now()}__`;
    const seeded = await svc
      .from("words")
      .insert({ input, translation: "y", source_lang: "JA", target_lang: "EN", is_verified: true })
      .select("word_id")
      .single();
    const wordId = (seeded.data as { word_id: string }).word_id;
    const u = await makeUser();
    const r = await u.client.rpc("save_dictionary_word", { p_user_id: u.userId, p_dictionary_word_id: wordId });
    const row = r.data as { stability: number | null; confidence_rating: number };
    expect(row.stability).toBeNull();
    expect(row.confidence_rating).toBe(0);
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

  // Readings switched correctly: a "usually kana" (uk) word headlines as KANA with
  // the kanji in the reading slot; a normal word keeps the KANJI headword + kana
  // reading. (The なる(成る) vs 鳴る(なる) behavior, asserted data-drivenly.)
  const hasKanji = (s: string) => /[一-龯]/.test(s);
  type LookupRow = { writing: string; input_reading: string | null; jmdict_entry_id: string };

  it("uk entries headline as KANA with the kanji in the reading slot", async () => {
    const svc = serviceClient();
    if (!svc) return;
    // A primary-sense (position 0) uk entry that ALSO has a kanji form (so the
    // kana-vs-kanji switch is observable). Skip if JMdict/uk data isn't present.
    const { data: ukSenses } = await svc
      .from("jmdict_senses").select("entry_id").eq("usually_kana", true).eq("position", 0).limit(50);
    if (!ukSenses?.length) return;
    let entry: string | null = null, kanji: string | null = null;
    for (const s of ukSenses as Array<{ entry_id: string }>) {
      const { data: k } = await svc.from("jmdict_kanji").select("text").eq("entry_id", s.entry_id).limit(1);
      if (k?.length) { entry = s.entry_id; kanji = (k[0] as { text: string }).text; break; }
    }
    if (!entry || !kanji) return;

    const { data } = await svc.rpc("jmdict_lookup", { p_input: kanji, p_source: "JA", p_target: "EN" });
    const row = ((data ?? []) as LookupRow[]).find((r) => r.jmdict_entry_id === entry);
    expect(row).toBeTruthy();
    expect(hasKanji(row!.writing)).toBe(false);             // headword is KANA
    expect(hasKanji(row!.input_reading ?? "")).toBe(true);  // kanji rides in the reading slot
  });

  it("non-uk entries keep the KANJI headword + kana reading (猫→ねこ)", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const { data } = await svc.rpc("jmdict_lookup", { p_input: "猫", p_source: "JA", p_target: "EN" });
    const rows = (data ?? []) as LookupRow[];
    if (rows.length === 0) return; // 猫 not in the loaded subset
    const neko = rows.find((r) => r.writing === "猫");
    expect(neko).toBeTruthy();
    expect(hasKanji(neko!.writing)).toBe(true);                 // kanji headword
    expect(neko!.input_reading).toBe("ねこ");                    // kana reading
  });

  // Homograph readings are never swapped: 辛い splits into からい / つらい on SEPARATE
  // entries, each carrying its own reading (a load-bearing invariant per CLAUDE.md).
  it("keeps homograph readings on their own entries (辛い → からい, つらい separate)", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const rows = ((await svc.rpc("jmdict_lookup", { p_input: "辛い", p_source: "JA", p_target: "EN" })).data ?? []) as LookupRow[];
    if (rows.length === 0) return; // 辛い not in the loaded subset
    // The kanji-headword 辛い entry reads からい (spicy) — NEVER swapped to つらい.
    const karai = rows.find((r) => r.writing === "辛い");
    expect(karai?.input_reading).toBe("からい");
    // つらい (painful) is a SEPARATE entry — uk, so it headlines as the kana writing.
    expect(rows.some((r) => r.writing === "つらい")).toBe(true);
  });

  // Headword frequency ordering: a kana search returns the most COMMON writing first
  // (いく → 行く ≫ 幾 / 逝く). Guards the ORDER BY frequency in jmdict_lookup.
  it("orders by headword frequency (いく → 行く first)", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const { data } = await svc.rpc("jmdict_lookup", { p_input: "いく", p_source: "JA", p_target: "EN" });
    const rows = (data ?? []) as LookupRow[];
    if (rows.length === 0) return; // いく not in the loaded subset
    expect(rows[0].writing).toBe("行く");
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

// ── consume_global_quota (#1 cost protection) ───────────────────────────────
describe.skipIf(!ENABLED || !SERVICE_KEY)("rpc: consume_global_quota", () => {
  it("is NOT callable by a client (no EXECUTE grant)", async () => {
    const u = await makeUser();
    const { error } = await u.client.rpc("consume_global_quota", { p_chars: 10, p_quota: 100 });
    expect(error).not.toBeNull();
  });

  it("reserves within the global cap and atomically denies over it", async () => {
    const svc = serviceClient();
    if (!svc) return;
    // Reset this month's global counter so the test is deterministic. UPDATE (not
    // DELETE — service_role has no DELETE grant on this server-only table); a
    // no-existing-row month just starts at 0.
    await svc.from("global_translation_usage").update({ chars_used: 0 }).neq("period_month", "1900-01-01");
    const quota = 25;
    const call = (chars: number) =>
      svc.rpc("consume_global_quota", { p_chars: chars, p_quota: quota });

    const r = (x: { data: unknown }) => (Array.isArray(x.data) ? x.data[0] : x.data) as {
      allowed: boolean;
      used: number;
    };
    expect(r(await call(10))).toEqual({ allowed: true, used: 10 });
    expect(r(await call(10))).toEqual({ allowed: true, used: 20 });
    expect(r(await call(10))).toEqual({ allowed: false, used: 20 }); // denied, no increment

    const { data: usage } = await svc.from("global_translation_usage").select("chars_used");
    expect((usage![0] as { chars_used: number }).chars_used).toBe(20);
    await svc.from("global_translation_usage").update({ chars_used: 0 }).neq("period_month", "1900-01-01");
  });
});

// ── refund_translation_quota (reserve → refund on a no-spend MT failure) ──────
describe.skipIf(!ENABLED || !SERVICE_KEY)("rpc: refund_translation_quota", () => {
  it("is NOT callable by a client (no EXECUTE grant)", async () => {
    const u = await makeUser();
    const { error } = await u.client.rpc("refund_translation_quota", { p_user_id: u.userId, p_chars: 1 });
    expect(error).not.toBeNull();
  });

  it("decrements the reserved chars and floors at 0", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const u = await makeUser();
    await svc.rpc("consume_translation_quota", { p_user_id: u.userId, p_chars: 10, p_quota: 1000 });
    await svc.rpc("refund_translation_quota", { p_user_id: u.userId, p_chars: 4 });
    const read = async () => {
      const { data } = await svc.from("translation_usage").select("chars_used").eq("user_id", u.userId);
      return (data?.[0] as { chars_used: number } | undefined)?.chars_used ?? 0;
    };
    expect(await read()).toBe(6); // 10 reserved − 4 refunded
    await svc.rpc("refund_translation_quota", { p_user_id: u.userId, p_chars: 100 }); // over-refund
    expect(await read()).toBe(0); // floored, never negative
  });
});

// ── related_words (#11) ─────────────────────────────────────────────────────
// word_embeddings is superuser-write-only (server-only, like jmdict_*): even
// service_role is denied, so we don't seed here — we exercise the RPC against the
// real ingested vectors (self-skipping the ordering assertion when absent) and
// assert the lockdown directly.
describe.skipIf(!ENABLED)("rpc: related_words", () => {
  const NEKO = "1467640"; // 猫 in JMdict — embedded once build-embeddings.py has run

  it("returns distance-ordered neighbours for an embedded entry (skips if not embedded)", async () => {
    const u = await makeUser();
    const { data, error } = await u.client.rpc("related_words", { p_entry_id: NEKO, p_limit: 5 });
    expect(error).toBeNull();
    const rows = (data ?? []) as { entry_id: string; distance: number }[];
    if (rows.length === 0) return; // embeddings not ingested in this env → skip the ordering check
    expect(rows.length).toBeLessThanOrEqual(5);
    expect(rows[0].entry_id).not.toBe(NEKO); // never returns the entry itself
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].distance).toBeGreaterThanOrEqual(rows[i - 1].distance); // nearest first
    }
  });

  it("returns nothing for an entry that has no embedding", async () => {
    const u = await makeUser();
    const { data } = await u.client.rpc("related_words", { p_entry_id: "___no_such_entry___", p_limit: 5 });
    expect((data as unknown[]) ?? []).toHaveLength(0);
  });

  it("does not expose raw vectors to clients (server-only table)", async () => {
    const u = await makeUser();
    const { data, error } = await u.client.from("word_embeddings").select("embedding").limit(1);
    expect(error !== null || (data ?? []).length === 0).toBe(true); // denied or empty — never vectors
  });
});

// ── privilege lockdown + delete_account (#hardening §1b) ────────────────────
describe.skipIf(!ENABLED || !SERVICE_KEY)("privilege lockdown", () => {
  it("service_role cannot DELETE user data", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "守る", meaning: "to protect" });
    const { error } = await svc.from("user_words").delete().eq("user_word_id", w);
    expect(error).not.toBeNull(); // 42501 permission denied
    const { data } = await u.client.from("user_words").select("user_word_id").eq("user_word_id", w);
    expect(data ?? []).toHaveLength(1); // row survives
  });

  it("delete_account erases the caller's data (+ audit) and leaves others intact", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const a = await makeUser();
    const b = await makeUser();
    await makeStandaloneWord(a, { input: "消す", meaning: "to erase" });
    await makeList(a, "DoomedList");
    const bWord = await makeStandaloneWord(b, { input: "残る", meaning: "to remain" });

    const { error } = await a.client.rpc("delete_account");
    expect(error).toBeNull();

    // A's data is gone (queried as A — same uid, now no rows)
    expect((await a.client.from("user_words").select("user_word_id")).data ?? []).toHaveLength(0);
    expect((await a.client.from("lists").select("list_id")).data ?? []).toHaveLength(0);
    // B untouched
    expect(
      (await b.client.from("user_words").select("user_word_id").eq("user_word_id", bWord)).data ?? [],
    ).toHaveLength(1);
    // audit row written (service_role-readable only)
    expect(
      (await svc.from("account_deletion_log").select("user_id").eq("user_id", a.userId)).data ?? [],
    ).toHaveLength(1);
  });
});
