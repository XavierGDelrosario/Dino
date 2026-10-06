// What an OAuth round-trip brings BACK when it fails.
//
// An OAuth sign-in or link leaves the app (a full-page redirect on web, an in-app
// browser on native) and GoTrue reports a failure only in the URL it returns to:
// `…#error=server_error&error_code=identity_already_exists&error_description=…`.
// Nothing read that, so the commonest collision — "Continue with Google" on a Google
// account that already belongs to another DINO user — returned the user to the app
// with no message at all.
//
// So before leaving we remember the INTENT (which page, which provider), and on the
// way back we turn an error into { intent, code } for that page to explain. This
// module is dependency-free on purpose: `captureOAuthReturnFromUrl` must run before
// the Supabase client is constructed (config/supabaseClient.ts), because the client's
// own URL detection can strip the fragment first.

export type OAuthProvider = "google" | "apple";
/** Where the round-trip started — and so where its error is shown. */
export type OAuthMode = "signin" | "signup";

export interface OAuthIntent {
  mode: OAuthMode;
  provider: OAuthProvider;
  /** Set on the automatic retry after a link collision, so it can't loop. */
  fallback?: boolean;
  at: number;
}

export interface OAuthReturnError {
  /** GoTrue's `error_code` (e.g. identity_already_exists), else its `error`. */
  code: string;
  description: string | null;
  /** null when the intent was lost (another tab, cleared storage, over the TTL). */
  intent: OAuthIntent | null;
}

/** GoTrue's code for a reset/confirmation link that expired or was already used. */
export const EMAIL_LINK_EXPIRED = "otp_expired";

const INTENT_KEY = "dino.oauthIntent";
// Long enough for a slow provider consent screen, short enough that a stale intent
// from an abandoned attempt can't label a later, unrelated error.
const INTENT_TTL_MS = 15 * 60 * 1000;

const PATH_BY_MODE: Record<OAuthMode, string> = {
  signin: "/signin",
  signup: "/signup",
};

export function rememberOAuthIntent(intent: Omit<OAuthIntent, "at">): void {
  try {
    localStorage.setItem(INTENT_KEY, JSON.stringify({ ...intent, at: Date.now() }));
  } catch {
    /* storage unavailable: the error still surfaces, just without its page */
  }
}

function takeIntent(): OAuthIntent | null {
  try {
    const raw = localStorage.getItem(INTENT_KEY);
    localStorage.removeItem(INTENT_KEY);
    if (!raw) return null;
    const intent = JSON.parse(raw) as OAuthIntent;
    return Date.now() - intent.at <= INTENT_TTL_MS ? intent : null;
  } catch {
    return null;
  }
}

let pending: OAuthReturnError | null = null;
const listeners = new Set<(e: OAuthReturnError) => void>();

/** Record a failed return (from the web URL or the native deep link). */
export function recordOAuthError(code: string, description: string | null): OAuthReturnError {
  const err: OAuthReturnError = { code, description, intent: takeIntent() };
  pending = err;
  listeners.forEach((fn) => fn(err));
  return err;
}

/** The pending error, once — the page that shows it clears it. */
export function takeOAuthError(): OAuthReturnError | null {
  const e = pending;
  pending = null;
  return e;
}

/** Native: the error arrives while the auth page is already mounted underneath the
 *  in-app browser, so it subscribes instead of reading once on mount. */
export function onOAuthError(fn: (e: OAuthReturnError) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Pull GoTrue's error params out of a URL's query and fragment. */
export function parseOAuthError(url: string): { code: string; description: string | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hash = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const get = (k: string) => parsed.searchParams.get(k) ?? hash.get(k);
  const code = get("error_code") ?? get("error");
  return code ? { code, description: get("error_description") } : null;
}

/**
 * WEB: if this page load is an OAuth return carrying an error, record it, strip the
 * params, and put the user back on the page that started the attempt (the router
 * reads location when it mounts, so rewriting it here is enough). Must run before
 * createClient. No-op on a normal load.
 */
export function captureOAuthReturnFromUrl(): void {
  if (typeof window === "undefined") return;
  const found = parseOAuthError(window.location.href);
  if (!found) return;
  const err = recordOAuthError(found.code, found.description);
  // An expired or already-used EMAIL link (reset, confirmation) comes back the same
  // way with no OAuth attempt behind it. Send it to sign-in, where the message is shown
  // and a new link can be requested — it used to land silently on Home.
  const path = err.intent
    ? PATH_BY_MODE[err.intent.mode]
    : err.code === EMAIL_LINK_EXPIRED
      ? PATH_BY_MODE.signin
      : window.location.pathname;
  window.history.replaceState(window.history.state, "", path);
}
