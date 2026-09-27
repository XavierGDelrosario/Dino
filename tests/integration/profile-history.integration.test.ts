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
      `INSERT INTO review_log (user_word_id, user_id, grade, reviewed_at, repeats)
       VALUES ($1, $2, 3, $3, $4)`,
      [id, user.userId, r.at, r.repeats ?? 1],
    );
  }
  return id;
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
