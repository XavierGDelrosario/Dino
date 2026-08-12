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
  backdateReview,
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
  // NOTE (20260729): every stability write is FUZZED (±15% here), so these assert
  // RANGES, not exact days — that nondeterminism is the feature (it stops a batch
  // reviewed together from coming due together). The CONFIDENCE bucket is derived
  // from the UN-fuzzed value, so it stays exact.
  it("first review seeds stability from the grade + appends a review_log row", async () => {
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "学ぶ", meaning: "to learn" });
    const { data, error } = await u.client.rpc("record_review", {
      p_user_word_id: w,
      p_grade: 5,
    });
    expect(error).toBeNull();
    const row = data as { stability: number; confidence_rating: number; last_reviewed_date: string };
    // Grade-5 seed = 40d (a custom word has no level → ease 1), ±15% fuzz.
    expect(row.stability).toBeGreaterThanOrEqual(40 * 0.85);
    expect(row.stability).toBeLessThanOrEqual(40 * 1.15);
    expect(row.confidence_rating).toBe(5); // un-fuzzed 40.0 → bucket >=35: confidence == grade
    expect(row.last_reviewed_date).not.toBeNull();

    const { data: log } = await u.client
      .from("review_log")
      .select("grade, new_stability")
      .eq("user_word_id", w);
    expect(log ?? []).toHaveLength(1);
    expect((log![0] as { grade: number }).grade).toBe(5);
  });

  it("fuzzes each write, so two words seeded identically do NOT come due together", async () => {
    // The anti-mass-review property, asserted directly: same word, same grade, same
    // instant → different stabilities. (P(collision) is ~0 for a REAL from a uniform
    // draw; a deterministic scheduler makes this fail every time.)
    const u = await makeUser();
    const stabilities = await Promise.all(
      ["一", "二", "三", "四", "五", "六"].map(async (input, i) => {
        const w = await makeStandaloneWord(u, { input, meaning: `n${i}` });
        const { data } = await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 5 });
        return (data as { stability: number }).stability;
      }),
    );
    expect(new Set(stabilities).size).toBeGreaterThan(1);
  });

  it("a lapse (grade 1) drops a word to a couple of DAYS, however mature it was", async () => {
    // The lapse is capped in ABSOLUTE days, not merely scaled — a percentage cut is
    // toothless once the ease has pushed a word out to hundreds of days (0.3 × 645d
    // would still be half a year, reading 5/5, for a word the user just forgot). This
    // is what keeps the level-based retirement honest, so assert the ceiling, not the
    // factor.
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "覚える", meaning: "to memorize" });
    await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 5 }); // ~40d
    const { data } = await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 1 });
    const row = data as { stability: number; confidence_rating: number };
    expect(row.stability).toBeLessThanOrEqual(2 * 1.15); // ≤ 2d cap, ±15% fuzz
    // FRESH failure (20260735): the word was aced moments ago, so the cut is amplified
    // (×0.2, landing on the 0.5d floor) and the peak-5 display floor is voided — it is
    // allowed to read 0. Forgetting a word you just aced is the strongest signal there is.
    expect(row.confidence_rating).toBe(0);
    // 20260744 caps the log at one row per card per UTC day, so these two same-day
    // reviews are ONE row — and ON CONFLICT only bumps `repeats`, leaving `grade` as
    // the day's FIRST. The lapse still happened (asserted on the returned row above);
    // what the log keeps is the day, not every grade in it.
    const { data: log } = await u.client
      .from("review_log")
      .select("grade, repeats")
      .eq("user_word_id", w);
    expect(log ?? []).toHaveLength(1);
    const entry = log![0] as unknown as { grade: number; repeats: number };
    expect(entry.grade).toBe(5); // the day's first review, not the lapse that followed
    expect(entry.repeats).toBe(2);
  });

  // ── the CRAM FREEZE: re-testing a word you still hold changes nothing ───────
  it("a SUCCESSFUL review of a still-fresh word (R > 0.9) is logged but changes nothing", async () => {
    // Measured before the fix: 14 days of daily grade-5 reviews took a word from 40d
    // to ~85d, so the model then claimed R = 0.84 at a two-week gap — a 14-day
    // retention claim from someone who only ever recalled it at ONE-day intervals.
    // Now a review while the word is still held teaches the scheduler nothing.
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "詰め込み", meaning: "cramming" });
    const first = await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 5 });
    const seeded = first.data as { stability: number; last_reviewed_date: string };

    // Immediately grade it 5 again (R ≈ 1) — and again.
    for (let i = 0; i < 2; i++) {
      const again = await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 5 });
      const row = again.data as { stability: number; last_reviewed_date: string };
      expect(row.stability).toBeCloseTo(seeded.stability, 5); // strength unmoved
      // The CLOCK is frozen too: resetting last_reviewed_date alone would push the
      // next review further out for free, which is the same inflation by another door.
      expect(row.last_reviewed_date).toBe(seeded.last_reviewed_date);
    }

    // Still recorded — but as ONE row for the day carrying a repeat count, not three
    // rows (20260744). The reviews happened; what changed is how they are stored.
    const { data: log } = await u.client
      .from("review_log")
      .select("grade, repeats")
      .eq("user_word_id", w);
    expect(log ?? []).toHaveLength(1);
    expect((log?.[0] as unknown as { repeats: number }).repeats).toBe(3);
  });

  it("a LAPSE is exempt from the freeze — failing a word you just saw still counts", async () => {
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "忘れる", meaning: "to forget" });
    await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 5 }); // ~40d, R ≈ 1
    const { data } = await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 1 });
    const row = data as { stability: number; confidence_rating: number };
    expect(row.stability).toBeLessThanOrEqual(2 * 1.15); // the ≤2d lapse cap still applies
    expect(row.confidence_rating).toBe(0); // fresh failure → amplified, floor voided (20260735)
  });

  it("a freshly-lapsed word is NOT frozen — daily study can still rehabilitate it", async () => {
    // A lapsed word sits at ~2d, so after a day R = exp(-1/2) = 0.61 — below the
    // freshness bar. This is what keeps daily practice useful for the words you're
    // actually failing, while refusing to reward cramming the ones you know.
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "苦手", meaning: "weak point" });
    await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 5 });
    const lapsed = await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 1 });
    const low = (lapsed.data as { stability: number }).stability; // ~2d

    // Age it one day. Done as the OWNER: service_role has no write grant on user data
    // at all (20260625_privileges.sql), and RLS lets a user manage their own row.
    const aged = await u.client
      .from("user_words")
      .update({ last_reviewed_date: new Date(Date.now() - 86_400_000).toISOString() })
      .eq("user_word_id", w)
      .select("last_reviewed_date");
    expect(aged.error).toBeNull();
    expect(aged.data ?? []).toHaveLength(1); // the backdate actually landed

    const { data } = await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 4 });
    expect((data as { stability: number }).stability).toBeGreaterThan(low); // it GREW
  });

  // ── the COLLAPSE: one row per card per UTC day (20260744) ──────────────────
  it("keeps the day's FIRST review and counts the rest, rather than one row each", async () => {
    // review_log is the only unbounded table in the schema — one row per graded card,
    // never deleted, because FSRS cannot be backfilled. Measured on prod: 303 B/row and
    // ~17 MB per user per year. Collapsing same-day reviews (the conventional FSRS
    // preprocessing) removed 24% of rows there, 92% of them cram-frozen ones the
    // scheduler already treats as teaching it nothing.
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "反復", meaning: "repetition" });

    await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 2 }); // the day's FIRST
    await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 5 });
    await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 5 });

    const { data } = await u.client
      .from("review_log")
      .select("grade, repeats, reviewed_on")
      .eq("user_word_id", w);
    const rows = (data ?? []) as unknown as { grade: number; repeats: number }[];
    expect(rows).toHaveLength(1);
    // The FIRST grade survives — it is the one carrying the real retention interval;
    // the later two are cramming and would bias a fit if they replaced it.
    expect(rows[0].grade).toBe(2);
    expect(rows[0].repeats).toBe(3);
  });

  it("the collapse cannot be used to forge history — no client write grant", async () => {
    // The only way a same-day repeat could overwrite the day's first grade is a direct
    // client write. review_log is read-own SELECT only (no INSERT/UPDATE grant), which
    // is what makes "keep the FIRST review" a guarantee rather than a convention.
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "改竄", meaning: "falsification" });
    await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 1 });

    const { error } = await u.client
      .from("review_log")
      .update({ grade: 5, repeats: 1 })
      .eq("user_word_id", w);
    expect(error).not.toBeNull();

    const { data } = await u.client.from("review_log").select("grade").eq("user_word_id", w);
    expect((data?.[0] as unknown as { grade: number }).grade).toBe(1);
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

// ── record_review p_reviewed_at (offline replay, migration 20260759) ────────
// The clamp is the security property: a client names the instant a queued grade was
// given, so it must not be able to fabricate an interval it never waited through.
describe.skipIf(!ENABLED)("rpc: record_review — p_reviewed_at", () => {
  /** A word with one review behind it, so there is a last_reviewed_date to clamp against. */
  async function reviewedWord(u: Awaited<ReturnType<typeof makeUser>>, input: string) {
    const w = await makeStandaloneWord(u, { input, meaning: "m" });
    await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 3 });
    return w;
  }

  it("omitting it is identical to the old two-arg call (now())", async () => {
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "既定", meaning: "default" });
    const { data, error } = await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 5 });
    expect(error).toBeNull();
    const row = data as { stability: number; last_reviewed_date: string };
    expect(row.stability).toBeGreaterThan(0);
    // Stamped ~now, not some other instant.
    expect(Math.abs(Date.parse(row.last_reviewed_date) - Date.now())).toBeLessThan(60_000);
  });

  it("CLAMPS a future timestamp to now() — no fabricated interval", async () => {
    const u = await makeUser();
    const w = await reviewedWord(u, "未来");
    const future = new Date(Date.now() + 400 * 86_400_000).toISOString(); // +400 days
    const { data, error } = await u.client.rpc("record_review", {
      p_user_word_id: w, p_grade: 5, p_reviewed_at: future,
    });
    expect(error).toBeNull();
    const stamped = Date.parse((data as { last_reviewed_date: string }).last_reviewed_date);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 60_000);
    // NOT asserted from review_log: both reviews land on the same UTC day, so
    // 20260744's UNIQUE (user_word_id, reviewed_on) collapses the second into the
    // first and only bumps `repeats` — the row still holds the FIRST review's values
    // (elapsed_days NULL, since a first-ever review has no interval). The
    // elapsed_days property is proven in the service-role block below, where the
    // rows can be aged onto different days.
  });

  it("CLAMPS a timestamp before last_reviewed_date — time cannot run backwards", async () => {
    const u = await makeUser();
    const w = await reviewedWord(u, "過去");
    const { data: before } = await u.client
      .from("user_words").select("last_reviewed_date").eq("user_word_id", w).single();
    const prev = Date.parse((before as { last_reviewed_date: string }).last_reviewed_date);

    const { data, error } = await u.client.rpc("record_review", {
      p_user_word_id: w,
      p_grade: 5,
      p_reviewed_at: new Date(prev - 30 * 86_400_000).toISOString(), // 30 days BEFORE
    });
    expect(error).toBeNull();
    const stamped = Date.parse((data as { last_reviewed_date: string }).last_reviewed_date);
    expect(stamped).toBeGreaterThanOrEqual(prev);
  });

  it("accepts a genuine past instant — the replay case actually works", async () => {
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "再生", meaning: "replay" });
    // Seed a first review, then age the card so a replay has room between the two.
    await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 5 });
    await u.client.from("user_words")
      .update({ last_reviewed_date: new Date(Date.now() - 10 * 86_400_000).toISOString() })
      .eq("user_word_id", w);

    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const { data, error } = await u.client.rpc("record_review", {
      p_user_word_id: w, p_grade: 4, p_reviewed_at: twoDaysAgo,
    });
    expect(error).toBeNull();
    // Stamped at the review, not at replay time — the whole point of p_reviewed_at.
    const stamped = Date.parse((data as { last_reviewed_date: string }).last_reviewed_date);
    expect(Math.abs(stamped - Date.parse(twoDaysAgo))).toBeLessThan(60_000);
  });

  it("a duplicated replay still collapses to ONE row with repeats = 2", async () => {
    // At-least-once delivery leans on this: the drain may send the same grade twice.
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "重複", meaning: "duplicate" });
    const at = new Date().toISOString();
    await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 4, p_reviewed_at: at });
    await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 4, p_reviewed_at: at });

    const { data: log } = await u.client
      .from("review_log").select("repeats").eq("user_word_id", w);
    expect(log ?? []).toHaveLength(1);
    expect((log![0] as { repeats: number }).repeats).toBe(2);
  });
});

// The property the whole feature rests on: the interval is measured from the instant
// the grade was GIVEN, not from when it reached the server. Needs the service role
// because both the card and its log row must be aged onto an earlier day — otherwise
// the replay collapses into today's row (20260744) and there is nothing to read.
describe.skipIf(!ENABLED || !SERVICE_KEY)("rpc: record_review — replay interval", () => {
  /**
   * Set a card up so a later review lands on a DIFFERENT UTC day: seed one review, then
   * age both the card and its log row. Without the second half, 20260744 collapses the
   * next review into today's row and there is nothing new to read.
   *
   * Returns the newest elapsed_days after `replay` runs, or null when this environment
   * can't backdate (no direct DB access) — the caller then skips, as its neighbours do.
   */
  async function elapsedAfterReplay(
    input: string,
    replay: (client: Awaited<ReturnType<typeof makeUser>>["client"], w: string) => Promise<void>,
  ): Promise<number | null> {
    const svc = serviceClient();
    if (!svc) return null;
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input, meaning: "m" });
    await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 5 });

    if (!(await backdateReview(w, 10))) return null;
    const aged = await svc
      .from("review_log")
      .update({ reviewed_at: new Date(Date.now() - 10 * 86_400_000).toISOString() })
      .eq("user_word_id", w);
    if (aged.error) return null; // couldn't age the log row → nothing to compare against

    await replay(u.client, w);

    const { data, error } = await svc
      .from("review_log").select("elapsed_days, reviewed_at").eq("user_word_id", w);
    expect(error).toBeNull();
    const rows = (data ?? []) as { elapsed_days: number | null; reviewed_at: string }[];
    if (rows.length < 2) return null; // the ageing didn't take on this DB → skip
    rows.sort((a, b) => Date.parse(b.reviewed_at) - Date.parse(a.reviewed_at));
    return rows[0].elapsed_days;
  }

  it("computes elapsed_days from the REPLAY instant, not the sync time", async () => {
    // A grade given 2 days ago on a card last reviewed 10 days ago: 8 days waited.
    const elapsed = await elapsedAfterReplay("間隔", async (client, w) => {
      const { error } = await client.rpc("record_review", {
        p_user_word_id: w,
        p_grade: 4,
        p_reviewed_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      });
      expect(error).toBeNull();
    });
    if (elapsed === null) return;
    expect(elapsed).toBeGreaterThan(7);
    expect(elapsed).toBeLessThan(9);
  });

  it("stamping at SYNC time instead measures 10 days — the bug this prevents", async () => {
    // The counterfactual: the identical setup WITHOUT p_reviewed_at records the full
    // interval to now, which is the wrong number a naive replay would produce.
    const elapsed = await elapsedAfterReplay("対照", async (client, w) => {
      await client.rpc("record_review", { p_user_word_id: w, p_grade: 4 });
    });
    if (elapsed === null) return;
    expect(elapsed).toBeGreaterThan(9);
  });
});

// ── server_now (the offline clock anchor, migration 20260759) ───────────────
describe.skipIf(!ENABLED)("rpc: server_now", () => {
  it("returns the server clock and is callable by a client", async () => {
    const u = await makeUser();
    const { data, error } = await u.client.rpc("server_now");
    expect(error).toBeNull();
    expect(Math.abs(Date.parse(data as string) - Date.now())).toBeLessThan(120_000);
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
    // First save WITH a seed → new row starts near stability 5 (±35% seed fuzz, and
    // ease 1: this user has no level), confidence from the UN-fuzzed 5 → bucket 2.
    const first = await u.client.rpc("save_dictionary_word", {
      p_user_id: u.userId,
      p_dictionary_word_id: wordId,
      p_initial_stability: 5,
    });
    expect(first.error).toBeNull();
    const row = first.data as { user_word_id: string; stability: number; confidence_rating: number };
    expect(row.stability).toBeGreaterThanOrEqual(5 * 0.65);
    expect(row.stability).toBeLessThanOrEqual(5 * 1.35);
    expect(row.confidence_rating).toBe(2); // 3 ≤ 5 < 7, from the base seed

    // Re-save with a DIFFERENT seed → existing row's stability is preserved.
    const again = await u.client.rpc("save_dictionary_word", {
      p_user_id: u.userId,
      p_dictionary_word_id: wordId,
      p_initial_stability: 30,
    });
    expect((again.data as { stability: number }).stability).toBeCloseTo(row.stability, 5); // unchanged
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
    // never-reviewed (R=0) + a strong one (conf 5, just reviewed → R≈1). Both standalone.
    const fresh = await makeStandaloneWord(u, { input: "新出", meaning: "new word" });
    const strong = await makeStandaloneWord(u, { input: "得意", meaning: "strong word" });
    await u.client.rpc("record_review", { p_user_word_id: strong, p_grade: 5 });

    const { data, error } = await u.client.rpc("review_queue", {
      p_user_id: u.userId,
      p_limit: 10,
    });
    expect(error).toBeNull();
    const queue = data as { user_word_id: string; retrievability: number; translation: string }[];
    expect(queue[0].user_word_id).toBe(fresh); // R=0 sorts first
    expect(queue[0].retrievability).toBe(0);
    expect(queue[0].translation).toBe("new word"); // resolved meaning rides along
    // …and the strong word is NOT dealt at all (20260732): it is fresh, so record_review
    // would FREEZE any grade ≥3 on it — a card the scheduler can't learn from is a card
    // that must not be served, or it comes back forever (the conf-5 replay bug).
    expect(queue.some((q) => q.user_word_id === strong)).toBe(false);

    const limited = await u.client.rpc("review_queue", { p_user_id: u.userId, p_limit: 1 });
    expect((limited.data as unknown[]).length).toBe(1);
  });

  // ── the due gate + fill phases (migration 20260732) ───────────────────────
  // The bug: with no due gate the queue dealt the least-fresh of a fully-fresh set, and
  // 20260729's cram freeze made grading those cards a no-op — so the SAME few conf-5
  // words came back every session, forever. These pin the fix.
  it("deals NOTHING when the whole vocabulary is known and fresh (no conf-5 replay)", async () => {
    const u = await makeUser();
    for (const input of ["住まい", "会議", "経済"]) {
      const id = await makeStandaloneWord(u, { input, meaning: `${input}-m` });
      await u.client.rpc("record_review", { p_user_word_id: id, p_grade: 5 });
    }
    // Many sessions in a row: all empty. (Before 20260732: the same three cards, forever.)
    //
    // The count is the regression detector, not decoration. 20260737's conf-5 cameo
    // fired on `random() < n * 0.01` — 10% per call at p_limit 10 — with nothing gating
    // it on the session having other material, so this state dealt one mastered card
    // whose grade the cram freeze then discarded. That made THIS spec fail ~27% of CI
    // runs at three sessions. 20260754 gates the cameo on `has_other`, so it is now
    // deterministically empty; 25 sessions would catch a reintroduction ~93% of the time
    // rather than the 27% three gave.
    for (let session = 0; session < 25; session++) {
      const { data } = await u.client.rpc("review_queue", { p_user_id: u.userId, p_limit: 10 });
      expect(data as unknown[]).toHaveLength(0);
    }
  });

  it("still deals a conf-5 word that has genuinely DECAYED (a mature word must be able to lapse)", async () => {
    const u = await makeUser();
    const decayed = await makeStandaloneWord(u, { input: "住まい", meaning: "residence" });
    const held = await makeStandaloneWord(u, { input: "会議", meaning: "meeting" });
    await u.client.rpc("record_review", { p_user_word_id: decayed, p_grade: 5 }); // S ≈ 40d
    await u.client.rpc("record_review", { p_user_word_id: held, p_grade: 5 });

    // 60 days later: R = exp(-60/40) ≈ 0.22 → below the 0.9 freshness line → DUE.
    if (!(await backdateReview(decayed, 60))) return; // no direct DB access → skip

    const { data } = await u.client.rpc("review_queue", { p_user_id: u.userId, p_limit: 10 });
    const queue = data as { user_word_id: string; confidence_rating: number }[];
    expect(queue.map((q) => q.user_word_id)).toContain(decayed); // decayed conf-5 → served
    expect(queue.map((q) => q.user_word_id)).not.toContain(held); // still fresh → not served
    // The DUE gate runs on true R, but the confidence SHOWN is the gentler display curve
    // (20260735): 40d of strength, 60 days away → 40·R^0.35 ≈ 23.6 → bucket 4. It reads
    // "worth a look", not "mastered" and not "forgotten".
    expect(queue.find((q) => q.user_word_id === decayed)!.confidence_rating).toBe(4);
  });

  // ── the live display confidence (migration 20260735) ──────────────────────
  it("shows a session's cramming WITHOUT moving the schedule", async () => {
    // Reported 2026-07-22: quizzing a word repeatedly in one sitting moved the display
    // 0 → 0 → 0, because the cram freeze (which protects the schedule, correctly) also
    // blanked the display. Now the frozen passes grow a short-term strength instead.
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "頑張る", meaning: "to persevere" });

    const first = await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 2 });
    const seeded = first.data as { stability: number; confidence_rating: number };
    expect(seeded.confidence_rating).toBe(2); // the grade reads back

    // Four more passes in the same sitting. Every one is frozen by the scheduler.
    const seen: number[] = [];
    for (const g of [4, 5, 5, 5]) {
      const { data } = await u.client.rpc("record_review", { p_user_word_id: w, p_grade: g });
      const row = data as { stability: number; confidence_rating: number };
      expect(row.stability).toBeCloseTo(seeded.stability, 5); // SCHEDULE untouched — still frozen
      seen.push(row.confidence_rating);
    }
    // …but the display climbed as the work went in.
    expect(seen[seen.length - 1]).toBeGreaterThan(seeded.confidence_rating);
    expect(seen).toEqual([...seen].sort((a, b) => a - b)); // monotone, never dropping mid-session
  });

  it("lets the crammed confidence decay overnight", async () => {
    // The other half of the deal: cramming is rewarded, then honestly forgotten. The
    // short-term strength half-lives in 8h, so by morning only the long term is left.
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "一夜漬け", meaning: "cramming overnight" });
    await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 2 });
    for (const g of [4, 5, 5]) {
      await u.client.rpc("record_review", { p_user_word_id: w, p_grade: g });
    }
    const { data: before } = await u.client
      .from("user_words").select("confidence_rating").eq("user_word_id", w).single();

    // Age the short-term clock by a day (3 half-lives) without touching the schedule.
    const aged = await u.client
      .from("user_words")
      .update({ short_stability_at: new Date(Date.now() - 86_400_000).toISOString() })
      .eq("user_word_id", w)
      .select("user_word_id");
    if ((aged.data ?? []).length === 0) return; // no write access → skip

    const { data } = await u.client.rpc("review_queue", {
      p_user_id: u.userId,
      p_limit: 10,
      p_user_word_ids: [w],
    });
    const live = (data as { confidence_rating: number }[])[0];
    expect(live.confidence_rating).toBeLessThan(
      (before as { confidence_rating: number }).confidence_rating
    );
  });

  // ── an explicit id set means "quiz exactly these" (migration 20260736) ────
  it("deals EVERY word in an explicit id set, due or not (the Retry quiz fix)", async () => {
    // Reported 2026-07-22: "words disappear from retry quiz, less flash cards". Retry
    // re-runs the set just finished — but every word in it was just graded, so it was
    // fresh, so the DUE gate dropped it and the fill quotas admitted only a slice. The
    // set shrank on every pass. An explicit id set now bypasses both phases.
    const u = await makeUser();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await makeStandaloneWord(u, { input: `再${i}`, meaning: `retry-${i}` });
      // Grade 5 → conf 5 AND fresh: previously the most-excluded combination there was.
      await u.client.rpc("record_review", { p_user_word_id: id, p_grade: 5 });
      ids.push(id);
    }

    // The general queue correctly deals nothing — everything is known and fresh.
    const general = await u.client.rpc("review_queue", { p_user_id: u.userId, p_limit: 20 });
    expect(general.data as unknown[]).toHaveLength(0);

    // Retry the exact set: all six come back, twice in a row (it must not shrink).
    for (let pass = 0; pass < 2; pass++) {
      const { data, error } = await u.client.rpc("review_queue", {
        p_user_id: u.userId,
        p_limit: 20,
        p_user_word_ids: ids,
      });
      expect(error).toBeNull();
      const queue = data as { user_word_id: string }[];
      expect(queue).toHaveLength(6);
      expect(queue.map((q) => q.user_word_id).sort()).toEqual([...ids].sort());
    }
  });

  it("still honours the limit on an explicit id set", async () => {
    const u = await makeUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await makeStandaloneWord(u, { input: `制限${i}`, meaning: `limit-${i}` }));
    }
    const { data } = await u.client.rpc("review_queue", {
      p_user_id: u.userId,
      p_limit: 3,
      p_user_word_ids: ids,
    });
    expect(data as unknown[]).toHaveLength(3);
  });

  it("fills a quiet session with the tuned mix — 12–17 conf ≤3, 3–8 conf-4, a conf-5 cameo at most", async () => {
    // Migration 20260734, against the default 20-card session: 3–8 conf-4, the rest shaky
    // (≤3), and confidence 5 ONLY via a 1%-per-slot cameo — capped at one, never filler.
    // The quotas are randomized per session, so assert the CONTRACT (bounds + the cap),
    // not one draw; the distribution itself was measured over 200 sessions.
    const u = await makeUser();
    const grade = async (input: string, g: number) => {
      const id = await makeStandaloneWord(u, { input, meaning: `${input}-m` });
      await u.client.rpc("record_review", { p_user_word_id: id, p_grade: g });
      return id;
    };
    for (let i = 0; i < 25; i++) await grade(`低${i}`, i % 2 ? 2 : 3); // conf 2–3, well populated
    for (let i = 0; i < 10; i++) await grade(`中${i}`, 4); // conf 4 — enough to fill the widened band
    for (let i = 0; i < 8; i++) await grade(`熟${i}`, 5); // conf 5

    // Nothing is due (everything was just reviewed) → every session is pure FILL.
    for (let session = 0; session < 5; session++) {
      const { data } = await u.client.rpc("review_queue", { p_user_id: u.userId, p_limit: 20 });
      const queue = data as { confidence_rating: number }[];
      expect(queue).toHaveLength(20);

      const low = queue.filter((q) => q.confidence_rating <= 3).length;
      const four = queue.filter((q) => q.confidence_rating === 4).length;
      const five = queue.filter((q) => q.confidence_rating === 5).length;

      expect(five, "the conf-5 cameo is capped at ONE per session").toBeLessThanOrEqual(1);
      expect(four, "conf-4 is a 15% floor + a uniform draw → 3–8 of 20").toBeGreaterThanOrEqual(3);
      expect(four).toBeLessThanOrEqual(8);
      expect(low, "the shaky pool is still the bulk of the session").toBeGreaterThanOrEqual(11);
      expect(low + four + five).toBe(20);
    }
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
  type LookupFreqRow = LookupRow & { frequency: number | null };

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

  // Own-frequency (20260720): a rare KANJI headword uses its OWN corpus frequency,
  // never a BORROWED value from its (common) kana reading. 亡い (deceased) shares the
  // kana ない with the very common negation, but 亡い's own kanji frequency is NULL —
  // it must NOT inherit ない's. Self-skips if 亡い isn't in the loaded subset.
  it("a rare kanji headword doesn't borrow its kana's frequency (亡い → own/NULL)", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const lookup = async (input: string) =>
      ((await svc.rpc("jmdict_lookup", { p_input: input, p_source: "JA", p_target: "EN" })).data ?? []) as LookupFreqRow[];
    const rows = (await lookup("亡い")).filter((r) => r.writing === "亡い");
    if (rows.length === 0) return; // 亡い not loaded
    // Its own kanji surface has no frequency → NULL, not the kana ない's high value.
    const naiFreq = (await lookup("ない"))[0]?.frequency ?? null;
    for (const r of rows) {
      expect(r.frequency).toBeNull();
      if (naiFreq != null) expect(r.frequency).not.toBe(naiFreq); // never the borrowed kana value
    }
  });

  // Secondary-writing headword (20260715 fix): searching a NON-preferred kanji form
  // must headline THAT form, not the entry's preferred kanji — else the edge's
  // groupByInput (input===term OR input_reading===term) can't attribute the result
  // and the token renders as unknown. Verified case: 傷む (secondary of 痛む/傷む).
  it("headlines the SEARCHED secondary kanji writing, not the preferred one", async () => {
    const svc = serviceClient();
    if (!svc) return;
    // Find any entry with ≥2 kanji writings so a secondary form exists; use the
    // non-preferred (later-position, non-uk) writing as the search term.
    const { data: k } = await svc
      .from("jmdict_kanji")
      .select("entry_id, text, position")
      .gt("position", 0) // a secondary writing (position 0 is preferred)
      .limit(200);
    const rowsK = (k ?? []) as Array<{ entry_id: string; text: string; position: number }>;
    let searched: { entry: string; text: string } | null = null;
    for (const r of rowsK) {
      // Skip uk entries (they headline as kana regardless — separate behavior).
      const { data: uk } = await svc
        .from("jmdict_senses").select("usually_kana").eq("entry_id", r.entry_id).eq("position", 0).limit(1);
      if ((uk?.[0] as { usually_kana: boolean } | undefined)?.usually_kana) continue;
      searched = { entry: r.entry_id, text: r.text };
      break;
    }
    if (!searched) return; // no multi-kanji entry in the loaded subset

    const rows = ((await svc.rpc("jmdict_lookup", {
      p_input: searched.text, p_source: "JA", p_target: "EN",
    })).data ?? []) as LookupRow[];
    const mine = rows.filter((r) => r.jmdict_entry_id === searched!.entry);
    expect(mine.length).toBeGreaterThan(0);
    // Every returned row for that entry headlines the SEARCHED writing, not the
    // preferred kanji — so the edge can attribute it back to the search term.
    for (const r of mine) expect(r.writing).toBe(searched.text);
  });
});

// ── consume_translation_quota (service-role only) ──────────────────────────
// ── wordnet_en_ja_lookup (service-role only) ───────────────────────────────
// The SEMANTIC EN->JA path (English lemma -> WordNet synsets -> Japanese lemmas,
// resolved through JMdict). Self-skips unless BOTH WordNet and JMdict are ingested
// (the function resolves JA lemmas against jmdict_*; an empty subset → no rows).
describe.skipIf(!ENABLED || !SERVICE_KEY)("rpc: wordnet_en_ja_lookup", () => {
  it("is NOT callable by a client (no EXECUTE grant)", async () => {
    const u = await makeUser();
    const { error } = await u.client.rpc("wordnet_en_ja_lookup", { p_input: "spring" });
    expect(error).not.toBeNull(); // permission denied — server-only
  });

  type WnRow = {
    translation: string;
    translation_reading: string | null;
    writing: string | null;
    sense_position: number;
    jmdict_entry_id: string | null;
    frequency: number | null;
  };

  it("returns synset-grouped JA senses for an English lemma (skips if WordNet/JMdict not ingested)", async () => {
    const svc = serviceClient();
    if (!svc) return;
    // Bail early if the WordNet source isn't loaded in this environment.
    const { data: probe } = await svc.from("wordnet_senses_en").select("lemma").limit(1);
    if (!probe || probe.length === 0) return; // WordNet not ingested → skip

    // Try a few common words; use the first that resolves (depends on which JMdict
    // subset is loaded). If none resolve, the JMdict side is absent/minimal → skip.
    const candidates = ["cat", "spring", "water", "book", "dog", "hand", "time"];
    let rows: WnRow[] = [];
    for (const word of candidates) {
      const { data, error } = await svc.rpc("wordnet_en_ja_lookup", { p_input: word });
      expect(error).toBeNull();
      rows = (data ?? []) as WnRow[];
      if (rows.length > 0) break;
    }
    if (rows.length === 0) return; // no candidate resolved against the loaded JMdict → skip

    // Every result is JMdict-backed (so it carries an authoritative reading/freq).
    for (const r of rows) {
      expect(r.translation).toBeTruthy();
      expect(r.jmdict_entry_id).toBeTruthy();
      expect(r.writing).toBeNull(); // EN->JA has no headword column
    }
    // sense_position is contiguous from 0 (the renumbered display rank).
    expect(rows.map((r) => r.sense_position)).toEqual(rows.map((_, i) => i));
    // entries are distinct (deduped by jmdict_entry_id).
    const ids = rows.map((r) => r.jmdict_entry_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── KNOWN GAPS (EN->JA quality, found 2026-06-28) — TODO, see docs/TODO.md ──
// These document shortcomings whose fixes are NOT built yet, so they currently
// FAIL. They are HARD-SKIPPED (describe.skip, not RUN_INTEGRATION-gated) so they
// never break CI — un-skip them when implementing the fix. Kept as executable
// specs of the intended behaviour rather than prose.

// NOTE: EN inflection is now handled in the EDGE function — resolveDictionary tries
// `lemmaCandidates(input, "EN")` (morphy: irregular map + regular detachment rules) and
// keeps the first that WordNet resolves. Covered by ACTIVE unit tests in
// tests/edge/translate-lib.test.ts. The raw SQL `wordnet_en_ja_lookup` still matches an
// EXACT lemma (the lemmatization is in the edge candidate loop, not the SQL), so these
// SQL-level specs stay SKIPPED as documentation of the raw function. Un-skip only if/when
// lemmatization is pushed DOWN into SQL (e.g. via an ingested verb.exc/noun.exc table).
describe.skip("KNOWN GAP (SQL-level): wordnet_en_ja_lookup matches exact lemma only", () => {
  // The raw SQL still won't lemmatize: "cats"↛"cat", "ran"↛"run", "ate"↛"eat". The edge
  // candidate loop is what fixes the user-facing result; this documents the SQL itself.
  const ids = (rows: unknown) =>
    new Set(((rows ?? []) as Array<{ jmdict_entry_id: string | null }>).map((r) => r.jmdict_entry_id));
  const senses = async (svc: NonNullable<ReturnType<typeof serviceClient>>, word: string) =>
    ids((await svc.rpc("wordnet_en_ja_lookup", { p_input: word })).data);

  it("a plural ('cats') resolves to the same JA senses as its singular ('cat')", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const plur = await senses(svc, "cats");
    expect(plur.size).toBeGreaterThan(0); // currently 0 — the gap
    expect(plur).toEqual(await senses(svc, "cat"));
  });

  it("a past-tense verb ('ran', 'ate') resolves like its base ('run', 'eat')", async () => {
    const svc = serviceClient();
    if (!svc) return;
    expect(await senses(svc, "ran")).toEqual(await senses(svc, "run")); // currently empty ≠ run
    expect(await senses(svc, "ate")).toEqual(await senses(svc, "eat"));
  });
});

// NOTE: the acronym/romaji noise (ＰＥＮ / ＢＩＳ for "international") is now FILTERED in
// the edge function (`dropOffScriptTranslations` in _lib.ts — covered by an ACTIVE
// unit test in tests/edge/translate-lib.test.ts). The SQL `jmdict_lookup` STILL returns
// those rows (we fixed it downstream, not in SQL), so this spec — which calls the raw
// SQL — stays SKIPPED as documentation of the SQL-level behaviour.
describe.skip("KNOWN GAP (SQL-level): jmdict_lookup gloss search returns acronym noise", () => {
  it("'international' does not return initialism/acronym headwords (PEN, BIS)", async () => {
    const svc = serviceClient();
    if (!svc) return;
    type Row = { writing: string };
    const rows = ((await svc.rpc("jmdict_lookup", { p_input: "international", p_source: "EN", p_target: "JA" })).data ?? []) as Row[];
    // Normalize full-width Latin to ASCII, then flag dotted/spaced all-caps initialisms.
    const toAscii = (s: string) => s.replace(/[Ａ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const isAcronym = (s: string) => /^[A-Z](\.?[A-Z]){1,}\.?$/.test(toAscii(s).replace(/\s/g, ""));
    expect(rows.some((r) => isAcronym(r.writing))).toBe(false);
  });
});

// ── jmdict_lookup_many (batch wrapper, service-role only) ──────────────────
describe.skipIf(!ENABLED || !SERVICE_KEY)("rpc: jmdict_lookup_many", () => {
  it("is NOT callable by a client (no EXECUTE grant)", async () => {
    const u = await makeUser();
    const { error } = await u.client.rpc("jmdict_lookup_many", {
      p_inputs: ["猫"], p_source: "JA", p_target: "EN",
    });
    expect(error).not.toBeNull(); // permission denied — server-only, like jmdict_lookup
  });

  it("resolves MANY inputs in one call, tagged by input, matching the single lookup", async () => {
    const svc = serviceClient();
    if (!svc) return;
    // Pick two real loaded headwords so the test doesn't depend on specific words.
    const { data: kanji } = await svc.from("jmdict_kanji").select("text").limit(2);
    if (!kanji || kanji.length < 2) return; // JMdict not ingested → skip
    const terms = (kanji as Array<{ text: string }>).map((k) => k.text);

    const { data, error } = await svc.rpc("jmdict_lookup_many", {
      p_inputs: terms, p_source: "JA", p_target: "EN",
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ input: string; translation: string }>;
    // Every requested term that the single lookup resolves is present, tagged.
    for (const term of terms) {
      const single = ((await svc.rpc("jmdict_lookup", { p_input: term, p_source: "JA", p_target: "EN" })).data ?? []) as unknown[];
      const batched = rows.filter((r) => r.input === term);
      expect(batched.length).toBe(single.length); // batch == single, per input
    }
  });
});

// ── learn_words_at_band (level-based new-words quiz; service-role only) ─────
// Sources UNSEEN headwords at a proficiency band from JMdict. Self-skips unless
// BOTH JMdict is ingested AND the proficiency wordlist has been joined in (bands
// are NULL otherwise → no candidates).
describe.skipIf(!ENABLED || !SERVICE_KEY)("rpc: learn_words_at_band", () => {
  it("is NOT callable by a client (no EXECUTE grant)", async () => {
    const u = await makeUser();
    const { error } = await u.client.rpc("learn_words_at_band", {
      p_source: "JA", p_target: "EN", p_band: 1, p_user_id: u.userId, p_limit: 5,
    });
    expect(error).not.toBeNull(); // permission denied — server-only
  });

  it("returns unique unseen JA headwords at a band, dropping one once it's saved", async () => {
    const svc = serviceClient();
    if (!svc) return;
    // Find a band that actually has data (proficiency ingested?), else skip.
    const { data: banded } = await svc
      .from("jmdict_kanji").select("proficiency_band").not("proficiency_band", "is", null).limit(1);
    if (!banded || banded.length === 0) return; // proficiency not ingested → skip
    const band = (banded[0] as { proficiency_band: number }).proficiency_band;

    const u = await makeUser();
    const learn = async (limit: number, excludeSeen: boolean): Promise<string[]> =>
      (((await svc.rpc("learn_words_at_band", {
        p_source: "JA", p_target: "EN", p_band: band, p_user_id: u.userId,
        p_limit: limit, p_exclude_seen: excludeSeen,
      })).data ?? []) as { headword: string }[]).map((r) => r.headword);

    // An unseen draw: unique, non-empty, no duplicate cards.
    const draw = await learn(5, true);
    expect(draw.length).toBeGreaterThan(0);
    expect(new Set(draw).size).toBe(draw.length);

    // It's a real JMdict word (resolves via the same lookup the edge uses).
    const first = draw[0];
    const senses = ((await svc.rpc("jmdict_lookup", { p_input: first, p_source: "JA", p_target: "EN" })).data ??
      []) as { jmdict_entry_id: string; translation: string }[];
    expect(senses.length).toBeGreaterThan(0);

    // "Save" the word for every entry that produces this headword (homographs may
    // split across entries), so it counts as SEEN.
    const entryIds = [...new Set(senses.map((s) => s.jmdict_entry_id))];
    for (const eid of entryIds) {
      const seeded = await svc.from("words").insert({
        input: first, translation: `learn-seed-${eid}`, source_lang: "JA", target_lang: "EN",
        is_verified: true, jmdict_entry_id: eid,
      }).select("word_id").single();
      const wordId = (seeded.data as { word_id: string }).word_id;
      await u.client.rpc("save_dictionary_word", { p_user_id: u.userId, p_dictionary_word_id: wordId });
    }

    // Once saved, the exclude_seen path SQL-filters it out, so it can't appear in
    // ANY draw — assert its ABSENCE. (We can't assert a specific word's PRESENCE:
    // selection is random AND PostgREST caps the response at 1000 rows, so for a
    // band with >1000 words a draw is a random subset — presence isn't guaranteed,
    // absence-of-a-filtered-word is.)
    expect(await learn(1000, true)).not.toContain(first);
  });

  it("drops a headword after ONE of its entries is saved (surface exclusion, migration 20260755)", async () => {
    // The test above has to save EVERY entry behind a headword to retire it. That
    // was the bug: exclusion keyed on jmdict_entry_id while the pool returns a
    // WRITING, so owning 神 under one of its 4 entries left the other 3 looking new
    // and the same card came back session after session (measured on prod: 36 of the
    // 60 words a 10-card N3 draw samples from were already in the vocabulary).
    // v6 also excludes by surface, so ONE save is enough.
    const svc = serviceClient();
    if (!svc) return;
    const u = await makeUser();
    const pool = (((await svc.rpc("learn_words_at_band", {
      p_source: "JA", p_target: "EN", p_band: 1, p_user_id: u.userId, p_limit: 400,
      p_exclude_seen: false,
    })).data ?? []) as { headword: string }[]).map((r) => r.headword);
    if (pool.length === 0) return; // proficiency/JMdict not ingested → skip

    // A headword JMdict splits across several entries — the case that leaked.
    let split: { headword: string; entryIds: string[] } | null = null;
    for (const headword of pool.slice(0, 60)) {
      const senses = ((await svc.rpc("jmdict_lookup", {
        p_input: headword, p_source: "JA", p_target: "EN",
      })).data ?? []) as { jmdict_entry_id: string }[];
      const entryIds = [...new Set(senses.map((s) => s.jmdict_entry_id))];
      if (entryIds.length > 1) { split = { headword, entryIds }; break; }
    }
    if (!split) return; // no multi-entry headword in this dictionary build → skip

    // Save exactly ONE of them — the other entries are still unseen by id.
    const seeded = await svc.from("words").insert({
      input: split.headword, translation: `learn-surface-${split.entryIds[0]}`,
      source_lang: "JA", target_lang: "EN", is_verified: true,
      jmdict_entry_id: split.entryIds[0],
    }).select("word_id").single();
    await u.client.rpc("save_dictionary_word", {
      p_user_id: u.userId,
      p_dictionary_word_id: (seeded.data as { word_id: string }).word_id,
    });

    const after = (((await svc.rpc("learn_words_at_band", {
      p_source: "JA", p_target: "EN", p_band: 1, p_user_id: u.userId, p_limit: 400,
    })).data ?? []) as { headword: string }[]).map((r) => r.headword);
    expect(after, `${split.headword} is owned — its other entries must not requiz it`)
      .not.toContain(split.headword);
    // Excluding one word must not empty the pool.
    expect(after.length).toBeGreaterThan(100);
  });

  it("never quizzes GRAMMATICAL words — particles, conjunctions, interjections, determiners, expressions, affixes", async () => {
    // Migration 20260730: a placement/learn card showing は or しかし tests grammar, not
    // vocabulary, and tells us nothing about the learner's LEVEL. The rule is judged on the
    // entry's PRIMARY sense (20260756), so this asserts the grammar entries are gone. Band 1
    // (N5) is where they cluster.
    //
    // THE LIMIT MUST EXCEED THE WHOLE POOL or this test samples instead of enumerating, and
    // absence becomes luck. It used to pass 400 against an N5 pool of 635 — これ surfaced in
    // ~2 runs of 3, and the resulting intermittent red was read as flake for long enough
    // that a genuine filter hole sat on main unfixed. The draw size is asserted below rather
    // than assumed, so if a pool ever outgrows this the test says so instead of going quiet.
    const LIMIT = 900; // < PostgREST's 1000-row response cap, > every band-1 pool measured
    const svc = serviceClient();
    if (!svc) return;
    const u = await makeUser();
    const draw = (((await svc.rpc("learn_words_at_band", {
      p_source: "JA", p_target: "EN", p_band: 1, p_user_id: u.userId, p_limit: LIMIT,
      p_exclude_seen: false,
    })).data ?? []) as { headword: string }[]).map((r) => r.headword);
    if (draw.length === 0) return; // proficiency/JMdict not ingested → skip
    expect(draw.length, "pool outgrew LIMIT — raise it; this draw is a sample, not the pool")
      .toBeLessThan(LIMIT);

    // これ/この (determiner+pronoun), しかし (conj), いいえ/さあ (int), ばかり (prt),
    // どういたしまして (exp) — all real N5-band entries the old affix-only filter let through.
    // これ needed migration 20260756: `pn` was missing from the excluded set AND the rule
    // kept any entry with ONE content sense, which これ met on a lone `adv` reading behind
    // five pronoun senses. It now judges the PRIMARY sense.
    for (const grammatical of ["これ", "この", "しかし", "いいえ", "さあ", "ばかり", "どういたしまして"]) {
      expect(draw, `${grammatical} must not be quizzable`).not.toContain(grammatical);
    }
    // …and the pool is still a pool (the filter trims the edges, it doesn't gut it).
    expect(draw.length).toBeGreaterThan(100);
  });

  it("varies across draws (random sample from a frequent pool → new words on retry)", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const { data: banded } = await svc
      .from("jmdict_kanji").select("proficiency_band").not("proficiency_band", "is", null).limit(1);
    if (!banded || banded.length === 0) return; // proficiency not ingested → skip
    const band = (banded[0] as { proficiency_band: number }).proficiency_band;
    const u = await makeUser();
    const draw = async () =>
      (((await svc.rpc("learn_words_at_band", {
        p_source: "JA", p_target: "EN", p_band: band, p_user_id: u.userId, p_limit: 8,
      })).data ?? []) as { headword: string }[]).map((r) => r.headword);
    const a = await draw();
    const b = await draw();
    // A band's frequent pool is far larger than 8, so two random draws differ
    // (deterministic top-N would return the identical list — the bug this fixes).
    if (a.length >= 8) expect(a.join(",")).not.toBe(b.join(","));
  });

  it("returns nothing for a pair with no curated framework", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const u = await makeUser();
    // KO→JA, not EN→JA: migration 20260745 gave English its own branch, so EN→JA
    // returns rows wherever english_proficiency is ingested. A pair with no branch at
    // all is what "no curated framework" means now.
    const { data, error } = await svc.rpc("learn_words_at_band", {
      p_source: "KO", p_target: "JA", p_band: 1, p_user_id: u.userId, p_limit: 5,
    });
    expect(error).toBeNull();
    expect((data as unknown[]) ?? []).toHaveLength(0);
  });

  // ── the ENGLISH branch (20260745), and its inflection filters (20260761) ──────
  // SELF-SKIPS unless the English leveling tables are ingested: english_proficiency /
  // english_frequency are NOT in db:dump-seed (see CLAUDE.md), so a fresh CI database
  // has no English pool and every draw below is empty.
  it("never deals an INFLECTED English form — irregulars excluded, participles demoted", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const u = await makeUser();
    const BAND = 4;
    const learn = async (limit: number): Promise<string[]> =>
      (((await svc.rpc("learn_words_at_band", {
        p_source: "EN", p_target: "JA", p_band: BAND, p_user_id: u.userId,
        p_limit: limit, p_exclude_seen: false,
      })).data ?? []) as { headword: string }[]).map((r) => r.headword);

    const wide = await learn(900);
    if (wide.length === 0) return; // English leveling not ingested → skip

    // (1) Irregular verb forms are excluded OUTRIGHT, so they cannot appear at any draw
    // size. `found` reads as the past of find, `saw` as the past of see — the learner
    // self-rates one word and we score another.
    for (const irregular of ["found", "known", "left", "saw", "thought", "given", "lost"]) {
      expect(wide, `${irregular} is an ambiguous inflection — it must not be quizzable`)
        .not.toContain(irregular);
    }

    // (2) Regular participles are DEMOTED, not removed: they sort behind the band's own
    // vocabulary, so a realistic draw (which reads only the top of the pool) never sees
    // one. Checked as a property rather than against a word list, so a re-ingested CEFR
    // list can't quietly invalidate it. Absence is the assertion — a draw is random
    // within its pool, so presence never is.
    const draw = await learn(20);
    expect(draw.length).toBeGreaterThan(0);
    const bases = new Map<string, string[]>();
    for (const w of draw) {
      // the -ing/-ed arms of morphy, mirroring en_participle_bases()
      if (w.length < 6) continue;
      const cands = w.endsWith("ing")
        ? [w.slice(0, -3), `${w.slice(0, -3)}e`]
        : w.endsWith("ed")
          ? [w.slice(0, -2), w.slice(0, -1), ...(w.endsWith("ied") ? [`${w.slice(0, -3)}y`] : [])]
          : [];
      const stem = w.endsWith("ing") ? w.slice(0, -3) : w.slice(0, -2);
      if (cands.length && /([bcdfghjklmnpqrstvwxz])\1$/.test(stem)) cands.push(stem.slice(0, -1));
      if (cands.length) bases.set(w, cands);
    }
    if (bases.size === 0) return; // nothing participle-shaped in this draw — nothing to check

    const all = [...new Set([...bases.values()].flat())];
    // Assert both reads SUCCEEDED. Without this a permission error would yield an empty
    // set, no candidate base would resolve, and the loop below would pass vacuously —
    // these are server-only tables whose grants have regressed before (20260746/20260748).
    const banded = await svc.from("english_proficiency")
      .select("surface, band").in("surface", all).lt("band", BAND);
    expect(banded.error).toBeNull();
    const easier = new Set(((banded.data ?? []) as { surface: string }[]).map((r) => r.surface));
    const verbal = await svc.from("wordnet_senses_en")
      .select("lemma, wordnet_synsets!inner(pos)").in("lemma", [...easier])
      .eq("wordnet_synsets.pos", "v");
    expect(verbal.error).toBeNull();
    const verbs = new Set(((verbal.data ?? []) as { lemma: string }[]).map((r) => r.lemma));

    for (const [word, cands] of bases) {
      const base = cands.find((b) => easier.has(b) && verbs.has(b));
      expect(base, `${word} is an inflection of "${base}" (banded easier) — it should have sorted last`)
        .toBeUndefined();
    }
  });
});

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

// The `related_words` / `word_embeddings` block that stood here was REMOVED with the
// word map itself (migration 20260741_drop_word_embeddings). Its first case asserted
// `error === null` from the RPC, so it fails outright once the function is gone — and
// the local integration job applies that migration. The feature is recoverable from
// git history (see the migration's header); so is this spec.

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

// ── srs_leveling + the ease (migration 20260731) ────────────────────────────
// The ease needs a MEASURED per-language profile (language_leveling /
// language_pos_offset, written by `npm run build:leveling -- JA`), so these self-skip
// on a DB where it hasn't been built — exactly like the JMdict-dependent tests. With no
// profile the scheduler falls back to ease 1.0, which is the whole point of the design:
// nothing is confidently wrong for a language we haven't measured.
describe.skipIf(!ENABLED || !SERVICE_KEY)("rpc: srs_leveling (the ease)", () => {
  /** A verified JA sense with explicit leveling. */
  const seedWord = async (
    svc: NonNullable<ReturnType<typeof serviceClient>>,
    attrs: { band?: number | null; frequency?: number | null; pos?: string[] },
  ): Promise<string> => {
    const r = await svc
      .from("words")
      .insert({
        input: `__lvl_${Math.random().toString(36).slice(2)}__`,
        translation: "x",
        source_lang: "JA",
        target_lang: "EN",
        is_verified: true,
        proficiency_band: attrs.band ?? null,
        frequency: attrs.frequency ?? null,
        part_of_speech: attrs.pos ?? null,
      })
      .select("word_id")
      .single();
    expect(r.error).toBeNull();
    return (r.data as { word_id: string }).word_id;
  };

  /** The profile is server-only (RLS, no policies) — service_role bypasses RLS. */
  const profile = async (): Promise<{ band_anchors: number[] } | null> => {
    const svc = serviceClient();
    if (!svc) return null;
    const { data } = await svc
      .from("language_leveling")
      .select("band_anchors")
      .eq("language", "JA")
      .maybeSingle();
    return (data as { band_anchors: number[] } | null) ?? null;
  };

  it("an N5 word an N3 user aces retires FAST; the same grade on an N3 word doesn't", async () => {
    const svc = serviceClient();
    const p = await profile();
    if (!svc || !p) return; // no measured profile on this DB → ease is 1.0 by design
    const [easyBand, atLevelBand] = [p.band_anchors[0], p.band_anchors[2]];
    const expectedEase = Math.min(2.5, 1 + 0.03 * (easyBand - atLevelBand));

    const easy = await seedWord(svc, { band: 1, frequency: 505, pos: ["n"] }); // N5
    const atLevel = await seedWord(svc, { band: 3, frequency: 430, pos: ["n"] }); // N3

    const u = await makeUser();
    // Learning JA, placed at N3 — the band is only meaningful for the language it was
    // measured in, which is why srs_leveling checks learning_language.
    const set = await u.client
      .from("users")
      .update({ proficiency_band: 3, learning_language: "JA" })
      .eq("user_id", u.userId);
    expect(set.error).toBeNull();

    const firstReview = async (wordId: string): Promise<number> => {
      const saved = await u.client.rpc("save_dictionary_word", {
        p_user_id: u.userId,
        p_dictionary_word_id: wordId,
      });
      expect(saved.error).toBeNull();
      const r = await u.client.rpc("record_review", {
        p_user_word_id: (saved.data as { user_word_id: string }).user_word_id,
        p_grade: 5,
      });
      expect(r.error).toBeNull();
      return (r.data as { stability: number }).stability;
    };

    // First grade-5 review seeds 40d × ease (±15% fuzz). The at-level word gets no ease.
    const easyS = await firstReview(easy);
    const atLevelS = await firstReview(atLevel);
    expect(easyS).toBeGreaterThanOrEqual(40 * expectedEase * 0.85);
    expect(easyS).toBeLessThanOrEqual(40 * expectedEase * 1.15);
    expect(atLevelS).toBeLessThanOrEqual(40 * 1.15); // ease 1.0
    expect(easyS).toBeGreaterThan(atLevelS);
  });

  it("the POS correction: an AFFIX earns less ease than a noun of the SAME frequency", async () => {
    // Frequency is per-surface, so affixes (which never inflect) concentrate their whole
    // corpus mass on one form and LOOK common without being easy — measured at +0.58 Zipf
    // above the median of their own JLPT band. The correction only ever pushes a word
    // HARDER, never easier.
    const svc = serviceClient();
    const p = await profile();
    if (!svc || !p) return;
    const noun = await seedWord(svc, { band: null, frequency: 505, pos: ["n"] });
    const affix = await seedWord(svc, { band: null, frequency: 505, pos: ["suf"] });

    const u = await makeUser();
    await u.client
      .from("users")
      .update({ proficiency_band: 3, learning_language: "JA" })
      .eq("user_id", u.userId);

    const easeOf = async (wordId: string): Promise<number> => {
      const { data } = await svc.rpc("srs_leveling", {
        p_user_id: u.userId,
        p_dictionary_word_id: wordId,
      });
      return (data as { ease: number; level_source: string }).ease;
    };
    const nounEase = await easeOf(noun);
    const affixEase = await easeOf(affix);
    expect(affixEase).toBeLessThan(nounEase); // same frequency, less ease
    expect(nounEase).toBeLessThanOrEqual(1.6); // frequency-only → the LOW cap, never 2.5
  });

  it("no ease when the word's language isn't the one the user's band was measured in", async () => {
    const svc = serviceClient();
    const p = await profile();
    if (!svc || !p) return;
    const en = await svc
      .from("words")
      .insert({
        input: `__lvl_en_${Date.now()}__`,
        translation: "x",
        source_lang: "EN",
        target_lang: "JA",
        is_verified: true,
        proficiency_band: 1,
        frequency: 600,
      })
      .select("word_id")
      .single();
    const u = await makeUser();
    await u.client
      .from("users")
      .update({ proficiency_band: 3, learning_language: "JA" }) // placed on JLPT
      .eq("user_id", u.userId);

    const { data } = await svc.rpc("srs_leveling", {
      p_user_id: u.userId,
      p_dictionary_word_id: (en.data as { word_id: string }).word_id,
    });
    // A CEFR band is not a JLPT band — comparing them would be meaningless, so: no ease.
    expect((data as { ease: number }).ease).toBe(1);
  });

  it("records WHY the schedule moved (review_log ease / positions / R)", async () => {
    // These columns can't be backfilled and are what will let us fit the ease curve
    // against real recall instead of against a wordlist.
    const svc = serviceClient();
    const p = await profile();
    if (!svc || !p) return;
    const wordId = await seedWord(svc, { band: 1, frequency: 505, pos: ["n"] });
    const u = await makeUser();
    await u.client
      .from("users")
      .update({ proficiency_band: 3, learning_language: "JA" })
      .eq("user_id", u.userId);
    const saved = await u.client.rpc("save_dictionary_word", {
      p_user_id: u.userId,
      p_dictionary_word_id: wordId,
    });
    const uw = (saved.data as { user_word_id: string }).user_word_id;
    await u.client.rpc("record_review", { p_user_word_id: uw, p_grade: 5 });

    const { data } = await u.client
      .from("review_log")
      .select("ease, word_position, user_position, level_source")
      .eq("user_word_id", uw)
      .single();
    const row = data as {
      ease: number;
      word_position: number;
      user_position: number;
      level_source: string;
    };
    expect(row.level_source).toBe("band");
    expect(row.ease).toBeGreaterThan(1);
    expect(row.word_position).toBeGreaterThan(row.user_position); // more common = below them
  });
});

// ── prune_review_log (service-role only, 20260744) ─────────────────────────
// The CEILING on the schema's only unbounded table. It removes nothing at today's
// volumes by design — its job is to make "grows forever" into "at most
// vocabulary x p_keep rows" — so what's asserted here is that it is enforceable,
// honest about what it would delete, and unreachable from a client.
describe.skipIf(!ENABLED || !SERVICE_KEY)("rpc: prune_review_log", () => {
  it("is NOT callable by a client (it deletes review history)", async () => {
    const u = await makeUser();
    const { error } = await u.client.rpc("prune_review_log", { p_keep: 1, p_dry_run: true });
    expect(error).not.toBeNull();
  });

  it("keeps at most p_keep rows per card, and dry-run matches what it deletes", async () => {
    const svc = serviceClient()!;
    const u = await makeUser();
    const w = await makeStandaloneWord(u, { input: "上限", meaning: "upper limit" });

    // Three separate DAYS of history: same-day reviews collapse, so the rows have to
    // be aged apart to exist at all. Backdating the word clears the cram freeze too.
    for (let i = 0; i < 3; i++) {
      await backdateReview(w, 60);
      await u.client.rpc("record_review", { p_user_word_id: w, p_grade: 4 });
      await svc
        .from("review_log")
        .update({ reviewed_at: new Date(Date.now() - (i + 1) * 86_400_000).toISOString() })
        .eq("user_word_id", w)
        .is("repeats", 1);
    }

    const before = await svc.from("review_log").select("reviewed_on").eq("user_word_id", w);
    const n = (before.data ?? []).length;
    if (n < 2) return; // the backdating didn't take on this DB — nothing to assert

    const dry = await svc.rpc("prune_review_log", { p_keep: 1, p_dry_run: true });
    const real = await svc.rpc("prune_review_log", { p_keep: 1, p_dry_run: false });
    expect(Number(dry.data)).toBe(Number(real.data)); // it said what it would do

    const after = await svc.from("review_log").select("reviewed_on").eq("user_word_id", w);
    expect((after.data ?? []).length).toBe(1);
  });

  it("rejects a nonsense keep count rather than emptying the table", async () => {
    const svc = serviceClient()!;
    const { error } = await svc.rpc("prune_review_log", { p_keep: 0, p_dry_run: true });
    expect(error).not.toBeNull();
  });
});

// ── report_quality_issue (user-filed quality reports; migration 20260759) ───
// The admin write RPC gates on is_admin(); this is the LEARNER's door to the same
// table, so the things worth proving live are the ones a unit test with a stubbed
// client cannot see: that an ordinary user may call it at all, that a report with no
// description is accepted (the admin one still requires text), and that the daily cap
// is enforced in the function rather than the client.
describe.skipIf(!ENABLED)("rpc: report_quality_issue", () => {
  const read = async (id: number) => {
    const svc = serviceClient();
    if (!svc) return null;
    const { data } = await svc
      .from("quality_reports")
      .select("input, description, source, reported_by, status")
      .eq("id", id)
      .single();
    return data as {
      input: string; description: string | null; source: string;
      reported_by: string | null; status: string;
    } | null;
  };

  it("lets an ORDINARY user file one, with no description", async () => {
    const u = await makeUser();
    const { data, error } = await u.client.rpc("report_quality_issue", { p_input: "猫" });
    expect(error).toBeNull();
    const row = data as { id: number; description: string | null; source: string } | null;
    expect(row).not.toBeNull();
    expect(row!.description).toBeNull(); // blank note stored as NULL, not ""
    expect(row!.source).toBe("user");

    const stored = await read(row!.id);
    if (stored) {
      expect(stored.reported_by).toBe(u.userId); // stamped from auth.uid(), not the client
      expect(stored.status).toBe("open"); // lands in the same triage queue as admin notes
    }
  });

  it("keeps the description when one is given, and trims it", async () => {
    const u = await makeUser();
    const { data } = await u.client.rpc("report_quality_issue", {
      p_input: "  辛い  ",
      p_description: "  wrong reading  ",
    });
    const row = data as { input: string; description: string | null };
    expect(row.input).toBe("辛い");
    expect(row.description).toBe("wrong reading");
  });

  it("rejects an empty target", async () => {
    const u = await makeUser();
    const { error } = await u.client.rpc("report_quality_issue", { p_input: "   " });
    expect(error).not.toBeNull();
  });

  // The admin notebook must be unchanged by all this: a note with no text is still
  // refused there, because an admin filing one always has something to say.
  it("still requires a description from the ADMIN write path", async () => {
    const u = await makeUser();
    const { error } = await u.client.rpc("admin_report_quality_issue", {
      p_input: "猫",
      p_description: "",
    });
    expect(error).not.toBeNull(); // non-admin AND empty — either way, refused
  });

  it("is NOT readable by the client (the table stays server-only)", async () => {
    const u = await makeUser();
    const { error } = await u.client.from("quality_reports").select("id").limit(1);
    expect(error).not.toBeNull();
  });
});
