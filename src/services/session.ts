// Session & user identity.
//
// Supabase ANONYMOUS auth: every visitor gets a real auth.uid() (so RLS works) with no
// login screen — the "guest profile". Upgrading to a real account only changes how the
// auth user is created; the public.users row and everything keyed on userId stay put.

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
 * Upgrade the CURRENT anonymous guest to a permanent email/password account: sets the
 * email + password on the SAME auth.uid(), so every user_words / list / review row
 * carries over with no data migration. Keeps the public.users email in sync.
 *
 * No captcha here — updateUser isn't one of the endpoints GoTrue gates (only those that
 * MINT a user or session are), and this guest already passed it at anonymous sign-in.
 */
export async function upgradeToAccount(
  params: { email: string; password: string },
): Promise<{ status: AuthStatus; emailPending: boolean }> {
  const email = params.email.trim().toLowerCase();
  const { data, error } = await supabase.auth.updateUser({ email, password: params.password });
  if (error) throw toServiceError(error, "Could not create your account");
  if (!data.user) throw toServiceError(null, "Could not create your account");
  // With email confirmations ON (prod) the change is PENDING until the link is clicked,
  // so `user.email` isn't the new address yet. Only sync once it has actually applied.
  const applied = (data.user.email || "").toLowerCase() === email;
  if (applied) await ensureUserProfile(data.user.id, email);
  return { status: toStatus(data.user as SupaUser), emailPending: !applied };
}

/**
 * Sign in to an EXISTING account, switching the session to that account's uid — words
 * saved as the current guest stay with the guest (use upgradeToAccount to keep them).
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
 * OAuth, shared by every provider. `link…` UPGRADES the current guest by linking the
 * identity to the SAME uid (data preserved) — use it from create-account; `signInWith…`
 * signs into the provider account as its own user (switching uid) — use it from sign-in.
 *
 * WEB: a full-page redirect out and back to the app origin, where onAuthStateChange
 * picks up the session. NATIVE: a redirect would escape the WebView to Safari and never
 * return, so we take the provider URL (skipBrowserRedirect), open it in an in-app
 * browser, and finish on our custom URL scheme — see services/nativeAuth.ts.
 *
 * Requires the provider enabled with OAuth creds in the Supabase project; unconfigured
 * → errors. Native also needs NATIVE_OAUTH_REDIRECT allow-listed + an Info.plist scheme.
 */
async function startOAuth(
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
  // Native: the appUrlOpen listener (nativeAuth) finishes the login from here.
  // Web: the call already redirected the page.
  if (native && data?.url) await Browser.open({ url: data.url });
}

export async function linkGoogle(): Promise<void> {
  await startOAuth(
    (options) => supabase.auth.linkIdentity({ provider: "google", options }),
    "Could not link Google",
  );
}
export async function signInWithGoogle(): Promise<void> {
  await startOAuth(
    (options) => supabase.auth.signInWithOAuth({ provider: "google", options }),
    "Google sign-in failed",
  );
}

/**
 * Sign in with Apple — same flow as Google, and REQUIRED rather than optional: App
 * Store guidelines make it mandatory for an app offering another third-party login, so
 * shipping to iOS without it is a rejection.
 *
 * Two non-code things Apple needs that Google doesn't: the Supabase project's Apple
 * provider must carry a Services ID + signing key, and "Hide My Email" returns a
 * private relay address — so an account may have no reachable email, and password
 * reset simply doesn't apply to an Apple-only account.
 */
export async function linkApple(): Promise<void> {
  await startOAuth(
    (options) => supabase.auth.linkIdentity({ provider: "apple", options }),
    "Could not link Apple",
  );
}
export async function signInWithApple(): Promise<void> {
  await startOAuth(
    (options) => supabase.auth.signInWithOAuth({ provider: "apple", options }),
    "Apple sign-in failed",
  );
}

/**
 * Stamp the current user's row with the Terms/Privacy acceptance. For an OAuth signup
 * this must run BEFORE the redirect — linkGoogle preserves the uid, so the stamp
 * survives it; for email it runs after the upgrade. Safe no-op with no session.
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
 * Does this account still owe Terms acceptance? True when its stored `terms_version` is
 * missing or behind CURRENT_TERMS_VERSION — an OAuth signup that bypassed the checkbox,
 * or anyone after a Terms update. Only checked for permanent accounts; guests aren't gated.
 */
export async function needsTermsAcceptance(userId: string): Promise<boolean> {
  const profile = await getUserProfile(userId);
  return !profile || profile.termsVersion !== CURRENT_TERMS_VERSION;
}

/** Sign out into a FRESH anonymous guest (no login wall). Returns the new userId. */
export async function signOut(): Promise<string> {
  await supabase.auth.signOut().catch(() => {});
  return ensureSession();
}

/**
 * Send a password-reset email. The link returns the user in a PASSWORD_RECOVERY session
 * (useSession surfaces it as `recovering`), where setNewPassword finishes the reset.
 * `redirectTo` must be in the project's auth URL allow-list.
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
 * Permanently delete the caller's account — BOTH their public-schema data AND their
 * auth identity — via the `delete-account` edge function (removing the auth row needs
 * the service role). Signs out on success, so `useSession` self-heals into a fresh
 * guest. Irreversible.
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

/** Current auth.uid(), or null if there's no session. Read-only; creates nothing. */
export async function getCurrentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/**
 * Guarantees an authenticated user (signing in anonymously if needed) AND a matching
 * public.users row. Call once on app start; returns the userId every service expects.
 *
 * Concurrent calls SHARE one in-flight sign-in. React StrictMode double-invokes the
 * bootstrap effect, and without this two `signInAnonymously` calls race — the resolved
 * userId can then mismatch the active session's JWT → 403 on the first write.
 */
let inflightSession: Promise<string> | null = null;
export function ensureSession(): Promise<string> {
  return (inflightSession ??= runEnsureSession().finally(() => {
    inflightSession = null;
  }));
}

async function runEnsureSession(): Promise<string> {
  // getUser can return an error OR throw (a network blip, or StrictMode racing two
  // refreshes of a stale token), so treat ANY failure as "no usable session".
  // The LOCAL session first — getSession reads storage and never touches the network,
  // so it is the only probe that can succeed offline.
  let user: { id: string; email?: string | null } | null = null;
  let offline = false;
  const { data: local } = await supabase.auth.getSession();

  if (local.session?.user) {
    // We hold a session. Ask the server whether it is still good, but treat the two
    // failure modes as DIFFERENT things — see the note on `invalidSession` below.
    const probe = await probeSession();
    if (probe === "valid") user = local.session.user;
    else if (probe === "unreachable") { user = local.session.user; offline = true; }
    // "invalid" leaves user null → the self-heal below runs, which is correct: the
    // server has positively told us this session is no good.
  }

  if (!user) {
    // No session at all, or one the server REJECTED (e.g. localStorage still holds a
    // token for an auth user wiped by `supabase db reset`). Purge and sign in fresh so
    // the app self-heals instead of dead-ending on "couldn't start a session".
    //
    // ‼️ Reaching here on a mere network failure is what made an offline launch
    // destructive: signOut() clears the stored session, the sign-in that follows also
    // fails, and a guest — whose whole vocabulary is keyed to that anonymous uid — comes
    // back online as a brand-new user with nothing. Hence the probe above.
    await supabase.auth.signOut().catch(() => {});
    // The sybil-relevant call: this MINTS an auth.users row for every visitor, so it's
    // the one the captcha guards (token is undefined when captcha is off).
    const captchaToken = await getCaptchaToken();
    const { data, error: signErr } = await supabase.auth.signInAnonymously({
      options: { captchaToken },
    });
    if (signErr || !data.user) {
      throw toServiceError(signErr, "Anonymous sign-in failed");
    }
    user = data.user;
  }

  // Anonymous users have an EMPTY-STRING email, not null, so `||` not `??`: without a
  // unique per-uid placeholder every guest inserts the same "" and collides on the
  // users_email UNIQUE constraint (23505). A real email replaces it on upgrade.
  //
  // Skipped when offline: it is an upsert of a row that already exists, so it can wait
  // for reconnect rather than failing a boot that has everything else it needs.
  if (!offline) {
    const email = user.email || `${user.id}@guest.dino`;
    await ensureUserProfile(user.id, email);
  }

  return user.id;
}

/**
 * Is the stored session still good, as far as the SERVER is concerned?
 *
 * The distinction this draws is the whole point: `getUser()` failing because the token
 * was revoked and `getUser()` failing because there is no network look identical at the
 * call site, and treating them alike is what let an offline launch wipe a guest.
 *
 *   "valid"       — the server answered and accepted the token.
 *   "invalid"     — the server answered and REJECTED it (401/403). Safe to purge.
 *   "unreachable" — we never got an answer. Keep what we have and carry on offline.
 *
 * Anything ambiguous resolves to "unreachable", because the cost is asymmetric: a
 * wrongly-kept dead session self-heals on the next successful call, while a wrongly-
 * purged live one can lose a guest's entire vocabulary.
 */
type SessionProbe = "valid" | "invalid" | "unreachable";

async function probeSession(): Promise<SessionProbe> {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (!error && data.user) return "valid";
    if (error && isRejection(error)) return "invalid";
    return "unreachable";
  } catch {
    // A thrown fetch is a network failure, never a verdict.
    return "unreachable";
  }
}

/** Did the server actually reject the token, as opposed to never being reached? */
function isRejection(error: { status?: number; name?: string }): boolean {
  if (error.status === 401 || error.status === 403) return true;
  // supabase-js surfaces a dropped connection as AuthRetryableFetchError; anything
  // retryable is by definition not a verdict.
  return error.name === "AuthApiError" && error.status !== undefined && error.status < 500;
}

/** Upserts the caller's own public.users row (RLS: user_id = auth.uid()). */
async function ensureUserProfile(userId: string, email: string): Promise<void> {
  const { error } = await supabase
    .from("users")
    .upsert({ user_id: userId, email }, { onConflict: "user_id" });
  if (error) throw toServiceError(error);
}

/** A user's profile, or null if it doesn't exist. RLS-scoped to the caller's own row. */
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

/** Update the caller's language preferences. Pass only the fields to change. */
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
