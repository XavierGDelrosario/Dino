// =========================================================
// Session & user identity.
//
// The POC uses Supabase ANONYMOUS auth: each visitor gets a real auth.uid()
// (so RLS works) without a login screen — the "guest profile" from DinoPOC.md.
// Upgrading to Google login later only changes how the auth user is created;
// the public.users row and everything keyed on userId stay the same.
// =========================================================

import { supabase } from "../config/supabaseClient";

export interface UserProfile {
  userId: string;
  email: string;
  dateCreated: string;
}

interface UserRow {
  user_id: string;
  email: string;
  date_created: string;
}

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
 * CONSTRAINTS: call once before any service; synthesizes a placeholder email
 * for anonymous users; relies on users-table RLS allowing the own-row upsert.
 */
export async function ensureSession(): Promise<string> {
  let {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error || !data.user) {
      throw error ?? new Error("Anonymous sign-in failed");
    }
    user = data.user;
  }

  // Anonymous users have no email; synthesize a stable placeholder so the
  // NOT NULL / UNIQUE constraint holds. A real email replaces it on upgrade.
  const email = user.email ?? `${user.id}@guest.dino`;
  await ensureUserProfile(user.id, email);

  return user.id;
}

/** Upserts the caller's own public.users row (RLS: user_id = auth.uid()). */
async function ensureUserProfile(userId: string, email: string): Promise<void> {
  const { error } = await supabase
    .from("users")
    .upsert({ user_id: userId, email }, { onConflict: "user_id" });
  if (error) throw error;
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

  if (error) throw error;
  if (!data) return null;

  return {
    userId: data.user_id,
    email: data.email,
    dateCreated: data.date_created,
  };
}
