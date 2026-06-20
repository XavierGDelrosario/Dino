// =========================================================
// Session & user identity.
//
// The POC uses Supabase ANONYMOUS auth: each visitor gets a real auth.uid()
// (so RLS works) without a login screen — the "guest profile" from DinoPOC.md.
// Upgrading to Google login later only changes how the auth user is created;
// the public.users row and everything keyed on userId stay the same.
// =========================================================

import { supabase } from "../config/supabaseClient";
import { toServiceError } from "./errors";
import type { Database } from "../types/database.types";

export interface UserProfile {
  userId: string;
  email: string;
  dateCreated: string;
}

// The `users` table row, derived from the generated schema types.
type UserRow = Database["public"]["Tables"]["users"]["Row"];

/**
 * Current authenticated user id, or null if there is no session yet.
 * OUTPUT: auth.uid() string, or null.
 * CONSTRAINTS: read-only; does not create a session.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/**
 * Guarantees an authenticated user (signing in anonymously if needed) AND a
 * matching public.users row. Call once on app start; returns the user id that
 * every service expects.
 *
 * OUTPUT: the userId.
 * CONSTRAINTS: synthesizes a placeholder email for anonymous users; relies on
 * users-table RLS allowing the own-row upsert.
 *
 * Concurrent calls SHARE one in-flight sign-in (the promise is reused until it
 * settles, then cleared). React StrictMode double-invokes the bootstrap effect;
 * without this, two `signInAnonymously` calls race and the resolved userId can
 * mismatch the active session's JWT → 403 on the first user_words write.
 */
let inflightSession: Promise<string> | null = null;
export function ensureSession(): Promise<string> {
  return (inflightSession ??= runEnsureSession().finally(() => {
    inflightSession = null;
  }));
}

async function runEnsureSession(): Promise<string> {
  // Probe the stored session. getUser can either return an error OR throw
  // (network blip, or StrictMode racing two refreshes of a stale token), so
  // treat ANY failure as "no usable session".
  let user: { id: string; email?: string | null } | null = null;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (!error) user = data.user;
  } catch {
    user = null;
  }

  // No user, OR a stale/invalid stored session — e.g. localStorage still holds a
  // token for an auth user wiped by a `supabase db reset`. Purge the stale
  // session and sign in fresh so the app self-heals instead of dead-ending on
  // "couldn't start a session".
  if (!user) {
    await supabase.auth.signOut().catch(() => {});
    const { data, error: signErr } = await supabase.auth.signInAnonymously();
    if (signErr || !data.user) {
      throw toServiceError(signErr, "Anonymous sign-in failed");
    }
    user = data.user;
  }

  // Anonymous users have an EMPTY-STRING email (not null), so use `||` not `??`:
  // synthesize a UNIQUE per-uid placeholder, otherwise every guest would insert
  // the same "" and collide on the users_email UNIQUE constraint (23505). A real
  // email replaces it on upgrade.
  const email = user.email || `${user.id}@guest.dino`;
  await ensureUserProfile(user.id, email);

  return user.id;
}

/** Upserts the caller's own public.users row (RLS: user_id = auth.uid()). */
async function ensureUserProfile(userId: string, email: string): Promise<void> {
  const { error } = await supabase
    .from("users")
    .upsert({ user_id: userId, email }, { onConflict: "user_id" });
  if (error) throw toServiceError(error);
}

/**
 * Reads a user's profile, or null if it does not exist.
 * OUTPUT: UserProfile | null.
 * CONSTRAINTS: RLS-scoped — only the caller's own row.
 */
export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from("users")
    .select<string, UserRow>("user_id, email, date_created")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw toServiceError(error);
  if (!data) return null;

  return {
    userId: data.user_id,
    email: data.email,
    dateCreated: data.date_created,
  };
}
