// =========================================================
// LIVE spec for migration 20260782 — account collisions.
//
//   * claim_guest_merge — a guest who signs in to an EXISTING account has its words
//     merged in (silently). Duplicates keep the stronger review state, colliding
//     list names merge their tags, the ticket is single-use.
//   * sign_in_methods   — names how the account holding an email signs in, and is
//     rate-limited per caller.
//
// supabase-js drives the real anonymous/password users (the functions key on
// auth.uid()); pg reaches what PostgREST can't — auth.identities, and user_words
// columns the app never writes directly (stability).
//
// Gated behind RUN_INTEGRATION; local only (signUp needs email confirmations OFF).
//   supabase start && npm run test:integration
// =========================================================
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import {
  ANON,
  DB_MATCHES_TARGET,
  DB_URL,
  ENABLED,
  URL,
  makeList,
  makeStandaloneWord,
  makeUser,
  type TestUser,
} from "./_support";

const db = new pg.Client({ connectionString: DB_URL });
let connected = false;
async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  if (!connected) {
    await db.connect();
    connected = true;
  }
  return (await db.query(text, params)).rows as T[];
}
afterAll(async () => {
  if (connected) await db.end();
});

/** A permanent email/password account (local: confirmations off, so it's confirmed). */
async function makeAccount(): Promise<TestUser & { email: string }> {
  const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `acct-${crypto.randomUUID()}@example.test`;
  const { data, error } = await client.auth.signUp({ email, password: "abc12345678" });
  if (error || !data.user) throw error ?? new Error("signUp failed");
  const { error: pe } = await client
    .from("users")
    .upsert({ user_id: data.user.id, email }, { onConflict: "user_id" });
  if (pe) throw pe;
  return { client, userId: data.user.id, email };
}

/** What a Google sign-up leaves behind: a confirmed user, a google identity, no
 *  password. Built by hand — GoTrue can't do a real Google round-trip locally. */
async function makeGoogleOnlyAccount(): Promise<{ userId: string; email: string }> {
  const email = `google-${crypto.randomUUID()}@example.test`;
  const [u] = await sql<{ id: string }>(
    `INSERT INTO auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at,
                             raw_app_meta_data, raw_user_meta_data, is_anonymous)
     VALUES ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
             $1, now(), now(), now(), '{"provider":"google","providers":["google"]}', '{}', false)
     RETURNING id`,
    [email],
  );
  await addIdentity(u.id, "google", email);
  return { userId: u.id, email };
}

function addIdentity(userId: string, provider: string, email: string) {
  return sql(
    `INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
     VALUES ($1, $2::uuid, jsonb_build_object('sub', $1::text, 'email', $3::text), $4, now(), now())`,
    [`${provider}-${crypto.randomUUID()}`, userId, email, provider],
  );
}

async function tag(user: TestUser, listId: string, userWordId: string) {
  const { error } = await user.client.from("list_words").insert({ list_id: listId, user_word_id: userWordId });
  if (error) throw error;
}

describe.skipIf(!ENABLED || !DB_MATCHES_TARGET)("claim_guest_merge (20260782)", () => {
  let guest: TestUser;
  let acct: TestUser & { email: string };
  let token: string;

  beforeAll(async () => {
    guest = await makeUser();
    acct = await makeAccount();

    // Guest: A (only theirs) and B (the account has it too); lists "Fav" (name
    // collides) holding A+B, and "Guest only" holding A.
    const gA = await makeStandaloneWord(guest, { input: "猫", meaning: "cat" });
    const gB = await makeStandaloneWord(guest, { input: "犬", meaning: "dog" });
    const gFav = await makeList(guest, "Fav");
    const gOnly = await makeList(guest, "Guest only");
    await tag(guest, gFav, gA);
    await tag(guest, gFav, gB);
    await tag(guest, gOnly, gA);

    // Account: B already, weaker than the guest's copy, in its own "Fav".
    const aB = await makeStandaloneWord(acct, { input: "犬", meaning: "dog" });
    const aFav = await makeList(acct, "Fav");
    await tag(acct, aFav, aB);
    await sql(`UPDATE user_words SET stability = 3,  peak_confidence = 2 WHERE user_word_id = $1`, [aB]);
    await sql(`UPDATE user_words SET stability = 40, peak_confidence = 5 WHERE user_word_id = $1`, [gB]);
    // A guest review of B on a day the account didn't review it: must follow B across.
    await sql(
      `INSERT INTO review_log (user_word_id, grade, reviewed_at, new_stability)
       VALUES ($1, 4, now() - interval '3 days', 40)`,
      [gB],
    );

    const { data, error } = await guest.client.rpc("create_guest_merge_ticket");
    expect(error).toBeNull();
    token = data as string;
    expect(token).toBeTruthy();
  });

  it("an EMPTY guest gets no ticket (nothing to carry)", async () => {
    const empty = await makeUser();
    const { data } = await empty.client.rpc("create_guest_merge_ticket");
    expect(data).toBeNull();
  });

  it("an account can't mint a ticket (only guests carry words)", async () => {
    const { data } = await acct.client.rpc("create_guest_merge_ticket");
    expect(data).toBeNull();
  });

  it("a GUEST can't claim (merging into a guest isn't a thing)", async () => {
    const other = await makeUser();
    const { data } = await other.client.rpc("claim_guest_merge", { p_token: token });
    expect(data).toBe(0);
    // …and the attempt didn't spend it: the real claim below still works.
  });

  it("merges the guest into the account", async () => {
    const { data, error } = await acct.client.rpc("claim_guest_merge", { p_token: token });
    expect(error).toBeNull();
    expect(data).toBe(2);

    const words = await sql<{ input: string; stability: number | null; peak_confidence: number }>(
      `SELECT input, stability, peak_confidence FROM user_words WHERE user_id = $1 ORDER BY input`,
      [acct.userId],
    );
    expect(words.map((w) => w.input).sort()).toEqual(["犬", "猫"].sort()); // B once, not twice
    const dog = words.find((w) => w.input === "犬")!;
    expect(dog.stability).toBe(40); // the stronger (guest) schedule won
    expect(dog.peak_confidence).toBe(5);

    const lists = await sql<{ list_name: string; words: string[] }>(
      `SELECT l.list_name, array_agg(uw.input ORDER BY uw.input) AS words
         FROM lists l JOIN list_words lw USING (list_id) JOIN user_words uw USING (user_word_id)
        WHERE l.user_id = $1 GROUP BY l.list_name ORDER BY l.list_name`,
      [acct.userId],
    );
    expect(lists).toEqual([
      { list_name: "Fav", words: ["犬", "猫"].sort() }, // tags merged into the account's Fav
      { list_name: "Guest only", words: ["猫"] }, // moved whole
    ]);

    // The log has no owner column (20260784) — it belongs to whoever owns its card.
    const log = await sql(
      `SELECT 1 FROM review_log r JOIN user_words uw USING (user_word_id) WHERE uw.user_id = $1`,
      [acct.userId],
    );
    expect(log).toHaveLength(1);

    const left = await sql<{ n: number }>(
      `SELECT (SELECT count(*) FROM user_words WHERE user_id = $1)
            + (SELECT count(*) FROM lists WHERE user_id = $1)
            + (SELECT count(*) FROM review_log r JOIN user_words uw USING (user_word_id)
                WHERE uw.user_id = $1) AS n`,
      [guest.userId],
    );
    expect(Number(left[0].n)).toBe(0); // the guest is empty → swept by the prune later
  });

  it("the ticket is single-use", async () => {
    const { data } = await acct.client.rpc("claim_guest_merge", { p_token: token });
    expect(data).toBe(0);
  });
});

describe.skipIf(!ENABLED || !DB_MATCHES_TARGET)("sign_in_methods (20260782)", () => {
  it("names the account's method, case-insensitively", async () => {
    const acct = await makeAccount();
    const asker = await makeUser();
    const ask = async (e: string) => (await asker.client.rpc("sign_in_methods", { p_email: e })).data;

    expect(await ask(acct.email.toUpperCase())).toEqual(["email"]);
    expect(await ask(`nobody-${crypto.randomUUID()}@example.test`)).toEqual([]);

    const g = await makeGoogleOnlyAccount();
    expect(await ask(g.email)).toEqual(["google"]);
  });

  it("is rate-limited per caller (a throttle reads the same as a miss)", async () => {
    const acct = await makeAccount();
    const asker = await makeUser();
    const results: unknown[] = [];
    for (let i = 0; i < 11; i++) {
      results.push((await asker.client.rpc("sign_in_methods", { p_email: acct.email })).data);
    }
    expect(results.slice(0, 10).every((r) => JSON.stringify(r) === '["email"]')).toBe(true);
    expect(results[10]).toEqual([]);
  });
});

describe.skipIf(!ENABLED || !DB_MATCHES_TARGET)("one sign-in method per account (20260782)", () => {
  it("a PASSWORD account can't gain a Google identity (GoTrue's auto-link is refused)", async () => {
    const acct = await makeAccount();
    await expect(addIdentity(acct.userId, "google", acct.email)).rejects.toThrow(/one_sign_in_method/);
  });

  it("a GOOGLE account can't gain an Apple identity", async () => {
    const g = await makeGoogleOnlyAccount();
    await expect(addIdentity(g.userId, "apple", g.email)).rejects.toThrow(/one_sign_in_method/);
  });

  it("a guest can't link an identity whose email another account holds", async () => {
    const acct = await makeAccount();
    const guest = await makeUser();
    await expect(addIdentity(guest.userId, "google", acct.email)).rejects.toThrow(/one_sign_in_method/);
  });

  it("a guest CAN take its first method (sign-up by Google)", async () => {
    const guest = await makeUser();
    await expect(
      addIdentity(guest.userId, "google", `new-${crypto.randomUUID()}@example.test`),
    ).resolves.toBeDefined();
  });

  it("a Google account can't be given a password through the reset flow", async () => {
    const g = await makeGoogleOnlyAccount();
    await expect(
      sql(`UPDATE auth.users SET encrypted_password = crypt('x', gen_salt('bf')) WHERE id = $1::uuid`, [g.userId]),
    ).rejects.toThrow(/one_sign_in_method/);
  });

  it("a guest can still upgrade to email + password (the sign-up path)", async () => {
    const guest = await makeUser();
    const { error } = await guest.client.auth.updateUser({
      email: `up-${crypto.randomUUID()}@example.test`,
      password: "abc12345678",
    });
    expect(error).toBeNull();
  });
});
