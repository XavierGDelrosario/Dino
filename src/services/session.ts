// Session & user identity.
//
// Supabase ANONYMOUS auth: every visitor gets a real auth.uid() (so RLS works) with no
// login screen — the "guest profile". Upgrading to a real account only changes how the
// auth user is created; the public.users row and everything keyed on userId stay put.

import { Browser } from "@capacitor/browser";
import { supabase } from "../config/supabaseClient";
import { getCaptchaToken } from "./captcha";
import { toServiceError } from "./errors";
import { CURRENT_TERMS_VERSION, termsOutdated } from "../lib/terms";
import { isNative, NATIVE_OAUTH_REDIRECT } from "./nativeAuth";
import type { Database } from "../types/database.types";
import { resetVocabulary } from "./words/vocabularyCache";
import { rememberOAuthIntent, type OAuthProvider } from "./oauthReturn";
import type { GoogleCredential } from "./googleIdentity";

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
 * Sign in to an EXISTING account, switching the session to that account's uid. Words
 * saved as the current guest are merged into the account once the switch lands
 * (prepareGuestMerge → claimGuestMerge, run by useSession).
 */
export async function signIn(params: { email: string; password: string }): Promise<AuthStatus> {
  const email = params.email.trim().toLowerCase();
  const captchaToken = await getCaptchaToken();
  await prepareGuestMerge(); // while we are still the guest — see claimGuestMerge
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

/**
 * Sign-up: LINK the provider to the current GUEST (same uid, so its words carry
 * over). A failed return is explained on /signup (services/oauthReturn).
 */
export async function linkProvider(provider: OAuthProvider): Promise<void> {
  rememberOAuthIntent({ mode: "signup", provider });
  await startOAuth(
    (options) => supabase.auth.linkIdentity({ provider, options }),
    `Could not link ${PROVIDER_NAME[provider]}`,
  );
}

/**
 * Sign in AS the provider's account (switching uid). A guest's words follow it via the
 * merge ticket. `fallback` marks the automatic retry after a sign-up link found the
 * provider account already registered, so a second failure can't loop.
 */
export async function signInWithProvider(
  provider: OAuthProvider,
  opts: { fallback?: boolean } = {},
): Promise<void> {
  rememberOAuthIntent({ mode: opts.fallback ? "signup" : "signin", provider, fallback: opts.fallback });
  await prepareGuestMerge();
  await startOAuth(
    (options) => supabase.auth.signInWithOAuth({ provider, options }),
    `${PROVIDER_NAME[provider]} sign-in failed`,
  );
}

const PROVIDER_NAME: Record<OAuthProvider, string> = { google: "Google", apple: "Apple" };

export const linkGoogle = () => linkProvider("google");
export const signInWithGoogle = () => signInWithProvider("google");

/**
 * The same two Google operations, from an ID TOKEN Google handed the page directly
 * (services/googleIdentity) instead of a redirect through Supabase's domain. WEB only.
 * Nothing leaves the page, so the outcome is a return value or a thrown ServiceError
 * carrying GoTrue's `code` — e.g. `identity_already_exists` when the Google account is
 * already a DINO user, which the auth page answers by signing in with the same token.
 */
export async function linkGoogleIdToken(credential: GoogleCredential): Promise<AuthStatus> {
  const { data, error } = await supabase.auth.linkIdentity({
    provider: "google",
    token: credential.token,
    nonce: credential.nonce,
  });
  if (error) throw toServiceError(error, "Could not link Google");
  if (!data.user) throw toServiceError(null, "Could not link Google");
  await ensureUserProfile(data.user.id, data.user.email || `${data.user.id}@guest.dino`);
  return toStatus(data.user as SupaUser);
}

export async function signInWithGoogleIdToken(credential: GoogleCredential): Promise<AuthStatus> {
  const captchaToken = await getCaptchaToken();
  await prepareGuestMerge(); // while we are still the guest — see claimGuestMerge
  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: "google",
    token: credential.token,
    nonce: credential.nonce,
    options: { captchaToken },
  });
  if (error) throw toServiceError(error, "Google sign-in failed");
  if (!data.user) throw toServiceError(null, "Google sign-in failed");
  await ensureUserProfile(data.user.id, data.user.email || `${data.user.id}@guest.dino`);
  return toStatus(data.user as SupaUser);
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
export const linkApple = () => linkProvider("apple");
export const signInWithApple = () => signInWithProvider("apple");

// ---------------------------------------------------------------------------
// Collisions. ONE email = one account = one method (password · Google · Apple),
// enforced on auth.* by migration 20260782; the app's job is to send people to the
// method their account actually uses.
// ---------------------------------------------------------------------------

/** How an existing account signs in, as sign_in_methods reports it. */
export type SignInMethod = "google" | "apple" | "email";

/**
 * What kind of collision a thrown auth error is, or null when it isn't one:
 * - "account_exists" — sign-up used an email another account already holds.
 * - "bad_credentials" — a password sign-in failed; the address may belong to an
 *   OAuth-only account, which is worth checking before showing the generic error.
 * GoTrue's codes, not its messages, which change between versions.
 */
export function collisionKind(e: unknown): "account_exists" | "bad_credentials" | null {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "email_exists" || code === "user_already_exists") return "account_exists";
  if (code === "invalid_credentials") return "bad_credentials";
  return null;
}

/**
 * The ways the account holding `email` signs in (google, apple, email — in that
 * order), or [] if none does. Only ever called AFTER a collision; the RPC is
 * rate-limited per caller and a throttled call also reads [], so treat [] as "don't
 * know", never as "no such account". An Apple "Hide My Email" account holds a relay
 * address, so a real address can't find it.
 */
export async function getSignInMethods(email: string): Promise<SignInMethod[]> {
  const { data, error } = await supabase.rpc("sign_in_methods", {
    p_email: email.trim().toLowerCase(),
  });
  if (error) return []; // a naming nicety — never let it mask the real error
  return toMethods(data);
}

function toMethods(data: unknown): SignInMethod[] {
  return ((data as string[] | null) ?? []).filter(
    (m): m is SignInMethod => m === "google" || m === "apple" || m === "email",
  );
}

// ---------------------------------------------------------------------------
// Guest → account merge (migration 20260782). Signing in to an EXISTING account
// switches uid, which used to strand the guest's words. The guest can't prove
// ownership after the switch, so it mints a single-use ticket FIRST; the account
// claims it once signed in. Silent by design — no prompt.
// ---------------------------------------------------------------------------

const MERGE_KEY = "dino.guestMerge";
const MERGE_TTL_MS = 60 * 60 * 1000; // mirrors the server's 1-hour ticket

/** Mint a merge ticket if the current user is a guest with something to carry.
 *  Best-effort: a failure here must never block the sign-in itself. */
async function prepareGuestMerge(): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    if ((data.session?.user as SupaUser | undefined)?.is_anonymous !== true) return;
    const { data: token, error } = await supabase.rpc("create_guest_merge_ticket");
    if (error || !token) return;
    localStorage.setItem(MERGE_KEY, JSON.stringify({ token, at: Date.now() }));
  } catch (e) {
    console.warn("Could not prepare the guest merge:", e);
  }
}

function readMergeTicket(): string | null {
  try {
    const raw = localStorage.getItem(MERGE_KEY);
    if (!raw) return null;
    const { token, at } = JSON.parse(raw) as { token: string; at: number };
    if (Date.now() - at > MERGE_TTL_MS) {
      localStorage.removeItem(MERGE_KEY);
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

/** Is a merge waiting to be claimed? (useSession holds the user switch until it's done.) */
export function hasPendingGuestMerge(): boolean {
  return readMergeTicket() !== null;
}

let inflightMerge: Promise<number> | null = null;
/**
 * Claim a pending merge into the CURRENT (non-guest) user. Returns how many guest
 * words were carried (0 when there was nothing to claim). Shared in-flight, because
 * both the bootstrap and the SIGNED_IN event can reach it on one sign-in. Never
 * throws — a failed merge leaves the words on the guest, which is where they were.
 */
export function claimGuestMerge(): Promise<number> {
  return (inflightMerge ??= runClaim().finally(() => {
    inflightMerge = null;
  }));
}

async function runClaim(): Promise<number> {
  const token = readMergeTicket();
  if (!token) return 0;
  try {
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user as SupaUser | undefined;
    if (!user || user.is_anonymous === true) return 0; // still the guest: keep the ticket
    localStorage.removeItem(MERGE_KEY); // single-use either way
    const { data: moved, error } = await supabase.rpc("claim_guest_merge", { p_token: token });
    if (error) throw error;
    resetVocabulary(); // the account's vocabulary just changed under the cache
    return (moved as number | null) ?? 0;
  } catch (e) {
    console.warn("Guest merge failed:", e);
    return 0;
  }
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
  // Never move an acceptance BACKWARDS: only stamp a row that has none or an older
  // one (see lib/terms.ts — an older build must not overwrite a newer acceptance).
  const { error } = await supabase
    .from("users")
    .update({ terms_agreed_at: new Date().toISOString(), terms_version: CURRENT_TERMS_VERSION })
    .eq("user_id", uid)
    .or(`terms_version.is.null,terms_version.lt.${CURRENT_TERMS_VERSION}`);
  if (error) throw toServiceError(error);
}

/**
 * Does this account still owe Terms acceptance? True when its stored `terms_version` is
 * missing or OLDER than CURRENT_TERMS_VERSION (a newer one, stamped by a newer build,
 * counts as accepted) — an OAuth signup that bypassed the checkbox,
 * or anyone after a Terms update. Only checked for permanent accounts; guests aren't gated.
 */
export async function needsTermsAcceptance(userId: string): Promise<boolean> {
  const profile = await getUserProfile(userId);
  return !profile || termsOutdated(profile.termsVersion);
}

/** Sign out into a FRESH anonymous guest (no login wall). Returns the new userId. */
export async function signOut(): Promise<string> {
  await supabase.auth.signOut().catch(() => {});
  resetVocabulary(); // don't hold the last account's vocabulary in memory
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
  resetVocabulary();
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
