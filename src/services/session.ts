// =========================================================
// Session & user identity.
//
// The POC uses Supabase ANONYMOUS auth: each visitor gets a real auth.uid()
// (so RLS works) without a login screen — the "guest profile" from DinoPOC.md.
// Upgrading to Google login later only changes how the auth user is created;
// the public.users row and everything keyed on userId stay the same.
// =========================================================

import { Browser } from "@capacitor/browser";
import { supabase } from "../config/supabaseClient";
import { getCaptchaToken } from "./captcha";
import { toServiceError } from "./errors";
import { CURRENT_TERMS_VERSION } from "../lib/terms";
import { isNative, NATIVE_OAUTH_REDIRECT } from "./nativeAuth";
import type { Database } from "../types/database.types";

export interface UserProfile {
  userId: string;
  email: string;
  dateCreated: string;
  /** Native language → default translation OUTPUT (target). null = app default. */
  nativeLanguage: string | null;
  /** Language being studied → default "I'm learning" + input. null = app default. */
  learningLanguage: string | null;
  /** When the user last accepted the Terms/Privacy (null = never, e.g. a guest). */
  termsAgreedAt: string | null;
  /** The Terms version they accepted (compare to CURRENT_TERMS_VERSION). */
  termsVersion: string | null;
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
// NOTE (captcha): this upgrades an EXISTING session via updateUser (PUT /user),
// which GoTrue does NOT captcha-gate — only the endpoints that MINT a user or a
// session do (signup / token / recover). That's fine: the guest whose session this
// upgrades already passed the captcha at anonymous sign-in, so the sybil surface is
// already covered. Nothing to pass here.
export async function upgradeToAccount(
  params: { email: string; password: string },
): Promise<{ status: AuthStatus; emailPending: boolean }> {
  const email = params.email.trim().toLowerCase();
  const { data, error } = await supabase.auth.updateUser({ email, password: params.password });
  if (error) throw toServiceError(error, "Could not create your account");
  if (!data.user) throw toServiceError(null, "Could not create your account");
  // With email confirmations ON (prod), the email change is PENDING until the user
  // clicks the link — `user.email` isn't the new address yet. Locally (confirmations
  // off) it applies immediately. Only sync the profile email once it's actually applied.
  const applied = (data.user.email || "").toLowerCase() === email;
  if (applied) await ensureUserProfile(data.user.id, email);
  return { status: toStatus(data.user as SupaUser), emailPending: !applied };
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
  const captchaToken = await getCaptchaToken();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: params.password,
    options: { captchaToken },
  });
  if (error) throw toServiceError(error, "Sign in failed");
  if (!data.user) throw toServiceError(null, "Sign in failed");
  await ensureUserProfile(data.user.id, data.user.email || `${data.user.id}@guest.dino`);
  return toStatus(data.user as SupaUser);
}

/**
 * Google OAuth. `linkGoogle` UPGRADES the current guest by linking a Google identity
 * to the SAME uid (data preserved) — use it from the create-account page. `signInWithGoogle`
 * signs into the Google account as its own user (switches uid) — use it from sign-in.
 *
 * WEB: a full-page redirect to Google → back to the app origin, where the client
 * picks up the session (onAuthStateChange). NATIVE (Capacitor/iOS): a redirect would
 * escape the WebView to Safari and never return, so we instead get the provider URL
 * (skipBrowserRedirect), open it in an in-app browser, and complete the login when
 * Google redirects back to our custom URL scheme — see services/nativeAuth.ts.
 *
 * Requires the Google provider enabled with OAuth creds in the Supabase project
 * (config.toml [auth.external.google]); unconfigured → errors. On native, also
 * requires NATIVE_OAUTH_REDIRECT in the redirect allow-list + Info.plist scheme.
 */
async function startGoogleOAuth(
  start: (opts: {
    redirectTo: string;
    skipBrowserRedirect: boolean;
  }) => Promise<{ data: { url?: string | null }; error: unknown }>,
  failMessage: string,
): Promise<void> {
  const native = isNative();
  const redirectTo = native
    ? NATIVE_OAUTH_REDIRECT
    : (typeof window !== "undefined" ? window.location.origin : "");
  const { data, error } = await start({ redirectTo, skipBrowserRedirect: native });
  if (error) throw toServiceError(error, failMessage);
  // Native: open the provider URL in an in-app browser; the appUrlOpen listener
  // (nativeAuth) finishes the login. Web: the call already redirected the page.
  if (native && data?.url) await Browser.open({ url: data.url });
}

export async function linkGoogle(): Promise<void> {
  await startGoogleOAuth(
    (options) => supabase.auth.linkIdentity({ provider: "google", options }),
    "Could not link Google",
  );
}
export async function signInWithGoogle(): Promise<void> {
  await startGoogleOAuth(
    (options) => supabase.auth.signInWithOAuth({ provider: "google", options }),
    "Google sign-in failed",
  );
}

/**
 * Stamp the current user's `users` row with the Terms/Privacy acceptance (the
 * moment + the CURRENT_TERMS_VERSION). Called from the signup flow once the user
 * ticks the agreement box. RLS scopes the write to the caller's own row. For
 * Google signup this must run BEFORE the OAuth redirect (the uid is preserved by
 * linkGoogle, so the stamp survives the redirect); for email it runs after the
 * upgrade. Safe no-op if there's no session.
 */
export async function recordTermsAgreement(): Promise<void> {
  const { data } = await supabase.auth.getUser();
  const uid = data.user?.id;
  if (!uid) return;
  const { error } = await supabase
    .from("users")
    .update({ terms_agreed_at: new Date().toISOString(), terms_version: CURRENT_TERMS_VERSION })
    .eq("user_id", uid);
  if (error) throw toServiceError(error);
}

/**
 * Does this account still owe Terms acceptance? True when its stored
 * `terms_version` is missing or behind CURRENT_TERMS_VERSION — i.e. a Google
 * signup that bypassed the signup checkbox, or anyone after the Terms were
 * updated. The caller (App) only checks this for permanent accounts; guests are
 * never gated. Reads the caller's own row (RLS).
 */
export async function needsTermsAcceptance(userId: string): Promise<boolean> {
  const profile = await getUserProfile(userId);
  return !profile || profile.termsVersion !== CURRENT_TERMS_VERSION;
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
  const captchaToken = await getCaptchaToken();
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
    redirectTo,
    captchaToken,
  });
  if (error) throw toServiceError(error, "Could not send the reset email");
}

/**
 * Permanently delete the caller's account — BOTH their public-schema data AND
 * their Supabase auth identity — via the `delete-account` edge function (the auth
 * row removal needs the service role; a client can't do it). On success we sign
 * out, so `useSession` self-heals into a fresh guest. Irreversible.
 */
export async function deleteAccount(): Promise<void> {
  const { error } = await supabase.functions.invoke("delete-account", { body: {} });
  if (error) throw toServiceError(error, "Could not delete your account");
  await supabase.auth.signOut().catch(() => {});
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
    // The sybil-relevant call: this MINTS an auth.users row for every visitor, so
    // it's the one the captcha guards (undefined token when captcha is off).
    const captchaToken = await getCaptchaToken();
    const { data, error: signErr } = await supabase.auth.signInAnonymously({
      options: { captchaToken },
    });
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
    .select<string, UserRow>("user_id, email, date_created, native_language, learning_language, terms_agreed_at, terms_version")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw toServiceError(error);
  if (!data) return null;

  return {
    userId: data.user_id,
    email: data.email,
    dateCreated: data.date_created,
    nativeLanguage: data.native_language,
    learningLanguage: data.learning_language,
    termsAgreedAt: data.terms_agreed_at,
    termsVersion: data.terms_version,
  };
}

/**
 * Update the caller's language preferences (native / learning). RLS scopes the
 * write to the caller's own row. Pass only the fields to change.
 */
export async function updateUserLanguages(params: {
  userId: string;
  nativeLanguage?: string;
  learningLanguage?: string;
}): Promise<void> {
  const patch: Database["public"]["Tables"]["users"]["Update"] = {};
  if (params.nativeLanguage !== undefined) patch.native_language = params.nativeLanguage;
  if (params.learningLanguage !== undefined) patch.learning_language = params.learningLanguage;
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabase.from("users").update(patch).eq("user_id", params.userId);
  if (error) throw toServiceError(error);
}
