// =========================================================
// LIVE spec for prune_anonymous_guests() (migration 20260727) — the empty-guest
// sweep, the second half of the [MED] anti-sybil item.
//
// This function DELETES USERS, so it does not get to ship on a mock. Every keep-rule
// below is asserted against real Postgres with real anonymous users: the sweep must
// take the abandoned, empty, old guests and NOTHING ELSE.
//
// Two connections, deliberately:
//   * supabase-js  — makes REAL anonymous users (the thing being swept) and proves a
//                    client cannot call the function.
//   * pg (postgres) — ages auth.users rows and invokes the function. PostgREST cannot
//                    reach the auth schema, and the function is cron/server-only, so
//                    SQL is the honest way to drive it.
//
// Gated behind RUN_INTEGRATION. To run:
//   supabase start
//   VITE_SUPABASE_URL=http://127.0.0.1:54321 \
//   VITE_SUPABASE_ANON_KEY=<local-anon-key> \
//   npm run test:integration
// =========================================================
import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import { ENABLED, makeUser, type TestUser } from "./_support";

declare const process: { env: Record<string, string | undefined> };

const DB_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const db = new pg.Client({ connectionString: DB_URL });
let connected = false;
async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  if (!connected) {
    await db.connect();
    connected = true;
  }
  const result = await db.query(text, params);
  return result.rows as T[];
}

afterAll(async () => {
  if (connected) await db.end();
});

/** Backdate a guest so the sweep's age cutoff sees them as abandoned. */
async function age(userId: string, interval: string): Promise<void> {
  await sql(
    `UPDATE auth.users
        SET created_at = now() - $2::interval,
            last_sign_in_at = now() - $2::interval
      WHERE id = $1::uuid`,
    [userId, interval],
  );
}

/** Run the sweep. Narrow the age window per-test so we only ever touch our own rows. */
async function prune(opts: { dryRun?: boolean; maxRows?: number } = {}): Promise<number> {
  const rows = await sql<{ prune_anonymous_guests: number }>(
    `SELECT prune_anonymous_guests(
        min_age  => interval '30 days',
        max_rows => $1::int,
        dry_run  => $2::boolean)`,
    [opts.maxRows ?? 500, opts.dryRun ?? false],
  );
  return rows[0].prune_anonymous_guests;
}

async function stillExists(userId: string): Promise<{ auth: boolean; profile: boolean }> {
  const [auth] = await sql<{ n: string }>(`SELECT count(*) n FROM auth.users WHERE id = $1::uuid`, [userId]);
  const [profile] = await sql<{ n: string }>(`SELECT count(*) n FROM public.users WHERE user_id = $1`, [userId]);
  return { auth: auth.n !== "0", profile: profile.n !== "0" };
}

/** An old, empty, abandoned guest — the ONLY thing the sweep should ever take. */
async function abandonedGuest(): Promise<TestUser> {
  const u = await makeUser();
  await age(u.userId, "60 days");
  return u;
}

describe.skipIf(!ENABLED)("prune_anonymous_guests: takes the abandoned guests", () => {
  it("deletes an old, empty guest — both the login and the profile row — and audits it", async () => {
    const guest = await abandonedGuest();

    const deleted = await prune();

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await stillExists(guest.userId)).toEqual({ auth: false, profile: false });
    // Every removal is recorded; the guard exists because a silent bulk delete once happened.
    const log = await sql(`SELECT 1 FROM account_deletion_log WHERE user_id = $1`, [guest.userId]);
    expect(log).toHaveLength(1);
  });

  it("dry-run counts the candidate but deletes NOTHING", async () => {
    const guest = await abandonedGuest();

    const wouldDelete = await prune({ dryRun: true });

    expect(wouldDelete).toBeGreaterThanOrEqual(1);
    expect(await stillExists(guest.userId)).toEqual({ auth: true, profile: true });
  });

  it("caps each run at max_rows", async () => {
    await abandonedGuest();
    await abandonedGuest();

    expect(await prune({ maxRows: 1 })).toBe(1);
  });
});

describe.skipIf(!ENABLED)("prune_anonymous_guests: leaves everything else alone", () => {
  it("KEEPS a guest who saved a word (their vocabulary is the whole point)", async () => {
    const guest = await abandonedGuest();
    const { error } = await guest.client.rpc("create_custom_word", {
      p_user_id: guest.userId,
      p_input: "いぬ",
      p_translation: "doggo",
      p_source: "JA",
      p_target: "EN",
    });
    expect(error).toBeNull();

    await prune();

    expect(await stillExists(guest.userId)).toEqual({ auth: true, profile: true });
  });

  it("KEEPS a guest who made a list, even with no words in it", async () => {
    const guest = await abandonedGuest();
    const { error } = await guest.client.from("lists").insert({
      user_id: guest.userId,
      list_name: "kept",
    });
    expect(error).toBeNull();

    await prune();

    expect(await stillExists(guest.userId)).toEqual({ auth: true, profile: true });
  });

  it("KEEPS a RECENT empty guest (someone who just opened the app)", async () => {
    const fresh = await makeUser(); // not aged

    await prune();

    expect(await stillExists(fresh.userId)).toEqual({ auth: true, profile: true });
  });

  it("KEEPS a guest with paid-MT spend THIS month — deleting them would reset their quota", async () => {
    const guest = await abandonedGuest();
    await sql(
      `INSERT INTO translation_usage (user_id, period_month, chars_used)
       VALUES ($1, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 5000)`,
      [guest.userId],
    );

    await prune();

    expect(await stillExists(guest.userId)).toEqual({ auth: true, profile: true });
  });

  it("KEEPS a real (non-anonymous) account, however old and empty", async () => {
    const account = await makeUser();
    await age(account.userId, "60 days");
    // Upgrade in place, exactly as the app does — same uid, no longer a guest.
    const { error } = await account.client.auth.updateUser({
      email: `sweep-${account.userId.slice(0, 8)}@example.com`,
      password: "correct horse battery 7", // the project policy wants letters + digits
    });
    expect(error).toBeNull();

    await prune();

    expect(await stillExists(account.userId)).toEqual({ auth: true, profile: true });
  });
});

describe.skipIf(!ENABLED)("prune_anonymous_guests: not reachable from a client", () => {
  it("cannot be called with the anon key (it is SECURITY DEFINER and deletes users)", async () => {
    const u = await makeUser();

    const { error } = await u.client.rpc("prune_anonymous_guests");

    expect(error).not.toBeNull();
  });
});
