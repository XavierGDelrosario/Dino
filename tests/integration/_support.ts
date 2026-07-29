// =========================================================
// Shared helpers for the LIVE integration suites (rls + constraints).
//
// Not a `*.test.ts` file, so vitest's `include` ("tests/**/*.test.ts") does NOT
// collect it as a suite — it's imported by the real specs. These stand up real
// anonymous users (the POC's auth mode) and, when a service-role key is present,
// a service-role client for seeding the server-only `words` cache.
//
// Env (read from process.env so the launcher's real env wins; see the run
// command in each spec's header):
//   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY   — required
//   SUPABASE_SERVICE_ROLE_KEY                    — optional (service-role blocks
//                                                  self-skip without it)
//   RUN_INTEGRATION=1                            — gates the whole suite
// =========================================================
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Scoped so this file typechecks without pulling @types/node into the project.
declare const process: { env: Record<string, string | undefined> };

export const URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
export const ANON = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
export const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.VITE_SUPABASE_SERVICE_ROLE_KEY ?? "";
export const ENABLED = process.env.RUN_INTEGRATION === "1";

export interface TestUser {
  client: SupabaseClient;
  userId: string;
}

/** A fresh anonymous user with its own session and a seeded public.users row. */
export async function makeUser(): Promise<TestUser> {
  // Independent client instance → independent (in-memory) session, so two users
  // can act concurrently. Not the config/supabaseClient singleton.
  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.user) throw error ?? new Error("anonymous sign-in failed");
  const userId = data.user.id;
  // lists.user_id / user_words.user_id FK requires the public.users row to exist.
  // Unique per-user email avoids the users.email UNIQUE collision (anon users
  // share an empty auth email).
  const { error: profileError } = await client
    .from("users")
    .upsert({ user_id: userId, email: `${userId}@guest.dino` }, { onConflict: "user_id" });
  if (profileError) throw profileError;
  return { client, userId };
}

/** Creates a sub-list for `user`, returns its id. */
export async function makeList(user: TestUser, name: string): Promise<string> {
  const { data, error } = await user.client
    .from("lists")
    .insert({ user_id: user.userId, list_name: name })
    .select("list_id")
    .single();
  if (error || !data) throw error ?? new Error("list seed failed");
  return (data as { list_id: string }).list_id;
}

/**
 * Inserts a standalone (created) user_words row with explicit language fields, so
 * tests can exercise non-Latin inputs and per-language-pair identity. Defaults to
 * JA→EN. Returns the new user_word_id.
 */
export async function makeStandaloneWord(
  user: TestUser,
  opts: { input: string; source?: string; target?: string; meaning: string },
): Promise<string> {
  const { data, error } = await user.client
    .from("user_words")
    .insert({
      user_id: user.userId,
      input: opts.input,
      source_lang: opts.source ?? "JA",
      target_lang: opts.target ?? "EN",
      dictionary_word_id: null,
      custom_translation: opts.meaning,
    })
    .select("user_word_id")
    .single();
  if (error || !data) throw error ?? new Error("could not seed user_word");
  return (data as { user_word_id: string }).user_word_id;
}

/**
 * Service-role client (bypasses RLS) — the ONLY way a test can seed a verified
 * `words` row, since clients can't write the dictionary. Returns null when no key
 * is set, so service-role blocks self-skip. NOTE: service_role has SELECT/INSERT/
 * UPDATE on `words` but NOT DELETE (words deletion is superuser-only by design),
 * so tests cannot exercise client/role-level `words` deletes.
 */
export function serviceClient(): SupabaseClient | null {
  if (!SERVICE_KEY) return null;
  return createClient(URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Simulate the PASSAGE OF TIME: move a word's last review `days` into the past, so the
 * scheduler sees it as decayed (R = exp(-Δ/S)). The only way to test what the review
 * queue does with a MATURE word — spaced repetition is a function of elapsed time, and a
 * test can't wait 60 days.
 *
 * Goes straight to Postgres as the owner, deliberately: `service_role` has NO write grant
 * on `user_words` (privilege hardening — only the caller, through RLS, and the definer
 * RPCs may touch a user's vocabulary), so even the service client cannot do this. Returns
 * false when the DB isn't reachable, so the calling test can self-skip rather than fail.
 */
export async function backdateReview(userWordId: string, days: number): Promise<boolean> {
  const { Client } = await import("pg");
  const pg = new Client({
    connectionString:
      process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  });
  try {
    await pg.connect();
  } catch {
    return false; // no direct DB access in this environment → skip
  }
  try {
    await pg.query(
      `UPDATE user_words
          SET last_reviewed_date = now() - make_interval(days => $2::int)
        WHERE user_word_id = $1`,
      [userWordId, days],
    );
    return true;
  } finally {
    await pg.end();
  }
}
