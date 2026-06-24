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

/** The live auth identity for the UI: who the user is and whether they're still a
 *  guest (anonymous) or a permanent account. */
export interface AuthStatus {
  userId: string;
  /** The real email for a permanent account; null while still an anonymous guest. */
  email: string | null;
  isAnonymous: boolean;
}

interface SupaUser {
  id: string;
  email?: string | null;
  is_anonymous?: boolean;
}

function toStatus(u: SupaUser): AuthStatus {
  const isAnonymous = u.is_anonymous === true;
  return { userId: u.id, email: isAnonymous ? null : u.email || null, isAnonymous };
}

/** Current auth identity, or null if there's no session yet. */
export async function getAuthStatus(): Promise<AuthStatus | null> {
  const { data } = await supabase.auth.getUser();
  return data.user ? toStatus(data.user as SupaUser) : null;
}

/**
 * Upgrade the CURRENT anonymous guest to a permanent email/password account. This
 * sets the email + password on the SAME auth.uid(), so every user_words / list /
 * review row (all keyed on that uid) carries over automatically — no data migration.
 *
 * OUTPUT: the new AuthStatus (isAnonymous=false).
 * CONSTRAINTS: normalizes the email; keeps the public.users row's email in sync.
 * Local dev has email confirmations OFF, so the email applies immediately; with
 * confirmations ON in prod, the email change is pending until confirmed.
 */
export async function upgradeToAccount(params: { email: string; password: string }): Promise<AuthStatus> {
  const email = params.email.trim().toLowerCase();
  const { data, error } = await supabase.auth.updateUser({ email, password: params.password });
  if (error) throw toServiceError(error, "Could not create your account");
  if (!data.user) throw toServiceError(null, "Could not create your account");
  // The profile row carried a @guest.dino placeholder — point it at the real email.
  await ensureUserProfile(data.user.id, email);
  return toStatus(data.user as SupaUser);
}

/**
 * Sign in to an EXISTING account (e.g. returning on a new device). This switches the
 * session to that account's uid — words saved as the current guest stay with the
 * guest (use upgradeToAccount to keep them). Ensures the account's public.users row.
 *
 * OUTPUT: the AuthStatus for the signed-in account.
 */
export async function signIn(params: { email: string; password: string }): Promise<AuthStatus> {
  const email = params.email.trim().toLowerCase();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: params.password });
  if (error) throw toServiceError(error, "Sign in failed");
  if (!data.user) throw toServiceError(null, "Sign in failed");
  await ensureUserProfile(data.user.id, data.user.email || `${data.user.id}@guest.dino`);
  return toStatus(data.user as SupaUser);
}

/**
 * Sign out and return to a FRESH anonymous guest (no login wall — the app keeps
 * working). Returns the new guest's userId.
 */
export async function signOut(): Promise<string> {
  await supabase.auth.signOut().catch(() => {});
  return ensureSession();
}

/**
 * Send a password-reset email. The link returns the user to the app in a
 * PASSWORD_RECOVERY session (useSession surfaces it as `recovering`), where
 * setNewPassword finishes the reset. `redirectTo` is the app origin and must be in
 * the project's auth URL allow-list (config.toml `additional_redirect_urls` locally;
 * Supabase dashboard → Authentication → URL Configuration in prod).
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const redirectTo = typeof window !== "undefined" ? window.location.origin : undefined;
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo });
  if (error) throw toServiceError(error, "Could not send the reset email");
}

/** Set a new password for the user currently in a recovery session (after they
 *  followed the reset link). Leaves them signed in to that account. */
export async function setNewPassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw toServiceError(error, "Could not update your password");
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
