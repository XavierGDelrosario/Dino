// =========================================================
// LIVE proof for profile_history() + snapshot_confidence_daily() (migration 20260775).
//
// Claims that need real Postgres:
//   1. Days are bucketed in the CALLER's timezone (a 16:00 UTC add is the NEXT day in
//      Tokyo), and reviewed = distinct cards, reviews = total grades (repeats).
//   2. Cross-user isolation: another user's activity never appears.
//   3. A deleted word's add and reviews vanish (hard delete + cascade) — "ignore deleted".
//   4. The nightly snapshot writes ONE row per ACTIVE user per day, is idempotent, skips
//      idle users, and clients can read only their own rows and write none.
//
// PREREQUISITES: supabase start (migration applied), RUN_INTEGRATION=1, and direct DB
// access (DATABASE_URL, default local :54322) — review_log/originally_translated_date
// have to be set to fixed instants, which no client role may do.
// =========================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client as PgClient } from "pg";
import { ENABLED, DB_URL, DB_MATCHES_TARGET, makeUser, makeStandaloneWord, type TestUser } from "./_support";

let pg: PgClient | null = null;

beforeAll(async () => {
  if (!ENABLED || !DB_MATCHES_TARGET) return;
  const { Client } = await import("pg");
  const c = new Client({
    connectionString: DB_URL,
    ssl: /127\.0\.0\.1|localhost/.test(DB_URL) ? undefined : { rejectUnauthorized: false },
  });
  try {
    await c.connect();
    pg = c;
  } catch {
    pg = null;
  }
});

afterAll(async () => {
  await pg?.end();
});

/** A word added at a fixed instant (UTC ISO), optionally reviewed at fixed instants. */
async function seedWord(user: TestUser, input: string, addedAt: string, reviews: { at: string; repeats?: number }[] = []) {
  const id = await makeStandaloneWord(user, { input, meaning: `${input}-m` });
  await pg!.query(`UPDATE user_words SET originally_translated_date = $2 WHERE user_word_id = $1`, [id, addedAt]);
  for (const r of reviews) {
    await pg!.query(
      `INSERT INTO review_log (user_word_id, grade, reviewed_at, repeats, new_stability)
       VALUES ($1, 3, $2, $3, 1)`,
      [id, r.at, r.repeats ?? 1],
    );
  }
  return id;
}

/** A saved DICTIONARY sense with the given POS / JMdict entry / band (service-seeded:
 *  clients can't write `words`). Unique per call so parallel runs never collide. */
async function seedSense(
  user: TestUser,
  o: {
    pos: string[];
    entry: string;
    band: number | null;
    frequency?: number;
    input?: string;
    /** Set the stored estimate directly (as apply-level-estimates would). */
    estimated?: number;
  },
) {
  const tag = Math.random().toString(36).slice(2, 10);
  const input = o.input ?? `史${tag}`;
  const w = await pg!.query(
    `INSERT INTO words (input, translation, source_lang, target_lang, is_verified, part_of_speech,
                        jmdict_entry_id, dictionary_ref, proficiency_band, frequency)
     VALUES ($1, 'x', 'JA', 'EN', true, $2, $3, $4, $5, $6) RETURNING word_id`,
    [input, o.pos, o.entry, `${o.entry}:${tag}`, o.band, o.frequency ?? null],
  );
  const wordId = w.rows[0].word_id as string;
  if (o.estimated !== undefined) {
    // Setting estimated_band alone does not fire the trigger, exactly like the backfill.
    await pg!.query(`UPDATE words SET estimated_band = $2 WHERE word_id = $1`, [wordId, o.estimated]);
  }
  await pg!.query(
    `INSERT INTO user_words (user_id, input, source_lang, target_lang, dictionary_word_id)
     VALUES ($1, $2, 'JA', 'EN', $3)`,
    [user.userId, input, wordId],
  );
  return wordId;
}

type Day = { day: string; added: number; reviewed: number; reviews: number };
async function history(user: TestUser, tz: string) {
  const { data, error } = await user.client.rpc("profile_history", { p_tz: tz });
  if (error) throw error;
  return data as { days: Day[]; confidence: { day: string; word_count: number }[] };
}
const on = (days: Day[], d: string) => days.find((x) => x.day === d);

describe.skipIf(!ENABLED)("profile_history()", () => {
  it("buckets by the caller's timezone and counts cards vs grades", async (ctx) => {
    if (!pg) return ctx.skip();
    const u = await makeUser();
    // 16:00 UTC on Sep 1 = 01:00 Sep 2 in Tokyo.
    await seedWord(u, "史A", "2026-09-01T16:00:00Z", [{ at: "2026-09-01T16:30:00Z", repeats: 3 }]);
    await seedWord(u, "史B", "2026-09-01T02:00:00Z", [{ at: "2026-09-01T16:10:00Z" }]);

    const utc = (await history(u, "UTC")).days;
    expect(on(utc, "2026-09-01")).toMatchObject({ added: 2, reviewed: 2, reviews: 4 });

    const tokyo = (await history(u, "Asia/Tokyo")).days;
    expect(on(tokyo, "2026-09-01")).toMatchObject({ added: 1, reviewed: 0 });
    expect(on(tokyo, "2026-09-02")).toMatchObject({ added: 1, reviewed: 2, reviews: 4 });

    // An unknown zone falls back to UTC rather than erroring.
    expect(on((await history(u, "Not/AZone")).days, "2026-09-01")).toMatchObject({ added: 2 });
  });

  it("never shows another user's activity, and drops a deleted word entirely", async (ctx) => {
    if (!pg) return ctx.skip();
    const a = await makeUser();
    const b = await makeUser();
    const gone = await seedWord(a, "史C", "2026-08-10T03:00:00Z", [{ at: "2026-08-11T03:00:00Z" }]);
    await seedWord(a, "史D", "2026-08-10T04:00:00Z");

    expect((await history(b, "UTC")).days).toEqual([]);
    expect(on((await history(a, "UTC")).days, "2026-08-10")?.added).toBe(2);

    const { error } = await a.client.from("user_words").delete().eq("user_word_id", gone);
    expect(error).toBeNull();
    const after = (await history(a, "UTC")).days;
    expect(on(after, "2026-08-10")?.added).toBe(1);
    expect(on(after, "2026-08-11")).toBeUndefined(); // its review cascaded away
  });
});

describe.skipIf(!ENABLED)("Unranked excludes grammar, affixes, interjections and names (20260776)", () => {
  it("drops those unranked senses from the level counts, keeps the rest", async (ctx) => {
    if (!pg) return ctx.skip();
    const u = await makeUser();
    await seedSense(u, { pos: ["prt"], entry: "2028990", band: null });     // に — grammar
    await seedSense(u, { pos: ["aux-v"], entry: "2654310", band: null });   // よう "let's"
    await seedSense(u, { pos: ["n"], entry: "5747047", band: null });       // とき the train — a name
    await seedSense(u, { pos: ["suf"], entry: "1005340", band: null });     // 〜さん — suffix
    await seedSense(u, { pos: ["pref"], entry: "1270190", band: null });    // 御〜 — prefix
    await seedSense(u, { pos: ["int"], entry: "2139720", band: null });     // ん "huh?" — interjection
    await seedSense(u, { pos: ["adv"], entry: "2158950", band: null });     // よう "well" — content
    await seedSense(u, { pos: ["prt"], entry: "1002980", band: 1 });        // a LISTED particle keeps its band
    await seedWord(u, "史H", "2026-07-21T05:00:00Z");                       // custom word: still unranked

    const { data, error } = await u.client.rpc("profile_history", { p_tz: "UTC" });
    expect(error).toBeNull();
    const bands = (data as { bands: { band: number; n: number }[] }).bands;
    expect(bands.find((b) => b.band === -1)?.n).toBe(2); // the adverb + the custom word
    expect(bands.find((b) => b.band === 1)?.n).toBe(1);

    // The nightly snapshot agrees (slot 0 = unranked), and its total still counts all 9.
    await pg!.query(`SELECT snapshot_confidence_daily((now() AT TIME ZONE 'UTC')::date)`);
    const row = await pg!.query(
      `SELECT word_count, band_n FROM user_confidence_daily WHERE user_id = $1`, [u.userId],
    );
    expect(row.rows[0]).toMatchObject({ word_count: 9, band_n: [2, 1] });
  });
});

describe.skipIf(!ENABLED)("stored level estimates (20260779)", () => {
  it("a cached word takes its writing's stored estimate by trigger; a curated band clears it", async (ctx) => {
    if (!pg) return ctx.skip();
    const u = await makeUser();
    // A throwaway dictionary entry below the JMdict-name range, whose writing carries an estimate.
    const entry = `48${Math.floor(Math.random() * 1e5).toString().padStart(5, "0")}`;
    const writing = `史推${entry}`;
    await pg!.query(`INSERT INTO jmdict_entries (entry_id) VALUES ($1) ON CONFLICT DO NOTHING`, [entry]);
    await pg!.query(
      `INSERT INTO jmdict_kanji (entry_id, text, common, frequency, position, estimated_band)
       VALUES ($1, $2, true, 420, 0, 5)`,
      [entry, writing],
    );
    const id = await seedSense(u, { pos: ["n"], entry, band: null, frequency: 420, input: writing });
    const est = async () =>
      (await pg!.query(`SELECT estimated_band FROM words WHERE word_id = $1`, [id])).rows[0].estimated_band;
    expect(await est()).toBe(5);                       // copied on insert — no edge change needed

    await pg!.query(`UPDATE words SET proficiency_band = 2 WHERE word_id = $1`, [id]);
    expect(await est()).toBeNull();                    // the list wins; the guess is dropped
  });

  it("History and the Lists summary show curated-else-stored-estimate", async (ctx) => {
    if (!pg) return ctx.skip();
    const u = await makeUser();
    await seedSense(u, { pos: ["n"], entry: "4900021", band: null, estimated: 5 }); // estimated N1
    await seedSense(u, { pos: ["n"], entry: "4900022", band: null });               // no estimate: unranked
    await seedSense(u, { pos: ["n"], entry: "4900023", band: 1 });                  // curated N5

    const { data: hist, error: e1 } = await u.client.rpc("profile_history", { p_tz: "UTC" });
    expect(e1).toBeNull();
    const bands = (hist as { bands: { band: number; n: number }[] }).bands;
    expect(bands.map((b) => [b.band, b.n])).toEqual([[-1, 1], [1, 1], [5, 1]]);

    const { data: lo, error: e2 } = await u.client.rpc("list_overview", {});
    expect(e2).toBeNull();
    const all = (lo as { list_id: string | null; band_counts: Record<string, number> }[])
      .find((r) => r.list_id === null)!;
    expect(all.band_counts).toEqual({ "-1": 1, "1": 1, "5": 1 });
  });
});

describe.skipIf(!ENABLED)("snapshot_confidence_daily()", () => {
  it("writes one row per active user per day, idempotently, and skips idle users", async (ctx) => {
    if (!pg) return ctx.skip();
    const active = await makeUser();
    const idle = await makeUser();
    await seedWord(active, "史E", "2026-07-20T05:00:00Z", [{ at: "2026-07-21T05:00:00Z" }]);
    await seedWord(active, "史F", "2026-07-01T05:00:00Z");
    await seedWord(idle, "史G", "2026-07-01T05:00:00Z"); // nothing on 07-21

    await pg!.query(`SELECT snapshot_confidence_daily('2026-07-21')`);
    await pg!.query(`SELECT snapshot_confidence_daily('2026-07-21')`); // re-run: same row

    const rows = await pg!.query(
      `SELECT user_id, word_count, band_n FROM user_confidence_daily
        WHERE day = '2026-07-21' AND user_id = ANY($1)`,
      [[active.userId, idle.userId]],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ user_id: active.userId, word_count: 2 });
    expect(rows.rows[0].band_n).toEqual([2]); // standalone words: all unranked (slot 0)

    // Visible to its owner through the RPC, invisible to anyone else.
    expect((await history(active, "UTC")).confidence.map((c) => c.day)).toContain("2026-07-21");
    const { data: peek } = await idle.client
      .from("user_confidence_daily" as never)
      .select("*")
      .eq("user_id", active.userId);
    expect(peek ?? []).toEqual([]);
  });

  it("refuses client writes", async (ctx) => {
    if (!pg) return ctx.skip();
    const u = await makeUser();
    const { error } = await u.client
      .from("user_confidence_daily" as never)
      .insert({ user_id: u.userId, day: "2026-01-01", word_count: 999 } as never);
    expect(error).not.toBeNull();
    const { error: rpcErr } = await u.client.rpc("snapshot_confidence_daily" as never, {} as never);
    expect(rpcErr).not.toBeNull();
  });
});
