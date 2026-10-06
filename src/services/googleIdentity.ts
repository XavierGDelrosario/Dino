// =========================================================
// Google sign-in WITHOUT the round-trip through Supabase's domain (web only).
//
// WHY: the Supabase redirect flow (session.ts startOAuth) sends the user to Google
// with a redirect URI on `<ref>.supabase.co`, so Google's consent screen reads
// "continue to <ref>.supabase.co" — a string no user recognises. The fixes Supabase
// offers are a paid custom domain or this: get an ID TOKEN from Google ourselves and
// hand it to Supabase (`signInWithIdToken` / `linkIdentity`).
//
// HOW: a full-page redirect to Google and back to OUR origin (OpenID Connect implicit
// flow, `response_type=id_token`). Google returns to `<origin>/auth/google` with the
// token in the URL fragment; `captureGoogleReturnFromUrl` lifts it out before the app
// renders and the app shell finishes the sign-in behind its splash (the user goes
// from Google straight to the app, never back through the form — only a FAILURE shows
// the auth page, with the reason). The redirect URI is ours, so the
// consent screen names this site, and `prompt=select_account` always offers the
// account chooser.
//
// WHY NOT GOOGLE'S OWN BUTTON (tried first, #126): its popup depends on cross-site
// cookies, so it hangs on a blank window in a private window or any browser that
// blocks them — and the page cannot detect that to fall back. A redirect needs
// neither popups nor third-party cookies.
//
// NONCE: Google is given the SHA-256 of a random value and stamps it into the token;
// Supabase is given the RAW value and checks the two match. STATE: a second random
// value, echoed back by Google and compared here, so a token can't be injected by a
// crafted link to /auth/google.
//
// OFF WITHOUT A CLIENT ID: no VITE_GOOGLE_CLIENT_ID → googleIdTokenEnabled() is false
// and callers keep the Supabase redirect flow. It must be the SAME web client the
// Supabase Google provider is configured with (the token's audience is checked
// server-side), and `<origin>/auth/google` must be in that client's "Authorised
// redirect URIs" for EVERY origin that serves the app — otherwise Google stops on a
// `redirect_uri_mismatch` page.
//
// NATIVE (iOS/Capacitor): the WebView has no https origin to return to, so native
// keeps the in-app-browser flow.
//
// This module must stay free of the Supabase client: `captureGoogleReturnFromUrl`
// runs BEFORE the client is constructed (config/supabaseClient.ts).
// =========================================================

import { Capacitor } from "@capacitor/core";
import { ServiceError } from "./errors";
import { recordOAuthError } from "./oauthReturn";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Where Google returns to. Served by the SPA fallback; never rendered as a page. */
export const GOOGLE_RETURN_PATH = "/auth/google";

const PENDING_KEY = "dino.googleSignIn";
// Long enough for a slow consent screen, short enough that an abandoned attempt
// can't be completed by a stale tab much later.
const PENDING_TTL_MS = 15 * 60 * 1000;

/** What Supabase needs to accept a Google sign-in: the ID token + the raw nonce. */
export interface GoogleCredential {
  token: string;
  nonce: string;
}

/** Which page started the round-trip — and so which one finishes it. */
export type GoogleMode = "signin" | "signup";

export interface GoogleReturn {
  credential: GoogleCredential;
  mode: GoogleMode;
}

interface Pending {
  mode: GoogleMode;
  nonce: string;
  state: string;
  at: number;
}

const PATH_BY_MODE: Record<GoogleMode, string> = { signin: "/signin", signup: "/signup" };

/** The Google OAuth WEB client id. Unset (the default) = this path is off. */
function clientId(): string | undefined {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID || undefined;
}

/** True when this build signs in with a Google ID token (web + a client id). */
export function googleIdTokenEnabled(): boolean {
  return Boolean(clientId()) && typeof window !== "undefined" && !Capacitor.isNativePlatform();
}

function randomValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}

/** A random nonce and the SHA-256 hex digest Google is given in its place. */
export async function makeNonce(): Promise<{ raw: string; hashed: string }> {
  const raw = randomValue();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hashed = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return { raw, hashed };
}

/**
 * The email address inside a Google ID token, or null if it can't be read. Used ONLY
 * to explain a refused sign-in (which method does this email's account use?) — the
 * token itself is verified by Supabase, never here.
 */
export function emailFromIdToken(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as { email?: unknown };
    return typeof claims.email === "string" && claims.email ? claims.email : null;
  } catch {
    return null;
  }
}

/**
 * Remember this attempt and build the Google URL to send the page to.
 * THROWS: ServiceError when no client id is configured.
 */
export async function buildGoogleAuthUrl(mode: GoogleMode): Promise<string> {
  const id = clientId();
  if (!id) throw new ServiceError("Google sign-in is not configured", "unknown");
  const nonce = await makeNonce();
  const state = randomValue();
  const pending: Pending = { mode, nonce: nonce.raw, state, at: Date.now() };
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: window.location.origin + GOOGLE_RETURN_PATH,
    response_type: "id_token",
    scope: "openid email profile",
    nonce: nonce.hashed,
    state,
    prompt: "select_account",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Leave for Google. The page unloads; the sign-in resumes in captureGoogleReturnFromUrl. */
export async function startGoogleSignIn(mode: GoogleMode): Promise<void> {
  window.location.assign(await buildGoogleAuthUrl(mode));
}

function takePending(): Pending | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    localStorage.removeItem(PENDING_KEY);
    if (!raw) return null;
    const pending = JSON.parse(raw) as Pending;
    return Date.now() - pending.at <= PENDING_TTL_MS ? pending : null;
  } catch {
    return null;
  }
}

let returned: GoogleReturn | null = null;

/**
 * If this page load is Google returning to /auth/google: lift the token out of the
 * URL, put the user back on the page that started the attempt (the router reads
 * location when it mounts, so rewriting it here is enough), and hold the credential
 * for that page to finish. A failed or tampered return is recorded as an OAuth error
 * for the same page to explain. Must run before createClient. No-op on a normal load.
 */
export function captureGoogleReturnFromUrl(): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname !== GOOGLE_RETURN_PATH) return;
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  const get = (key: string) => fragment.get(key) ?? query.get(key);

  const pending = takePending();
  // Strip the token from the address bar and history before anything else can read it.
  window.history.replaceState(window.history.state, "", PATH_BY_MODE[pending?.mode ?? "signin"]);

  const error = get("error");
  if (error) {
    recordOAuthError(error, get("error_description")); // access_denied = cancelled → no message
    return;
  }
  const token = get("id_token");
  if (!token) return; // someone opened /auth/google directly
  if (!pending || get("state") !== pending.state) {
    recordOAuthError("state_mismatch", null);
    return;
  }
  returned = { credential: { token, nonce: pending.nonce }, mode: pending.mode };
}

/** Is a Google return waiting to be finished? (The app holds its splash until it is.) */
export function hasGoogleReturn(): boolean {
  return returned !== null;
}

/** The credential Google just returned with, once — the app shell finishes it. */
export function takeGoogleReturn(): GoogleReturn | null {
  const r = returned;
  returned = null;
  return r;
}

/**
 * Why a returned sign-in was refused, for the auth page to explain: GoTrue's code,
 * plus — when the email's account signs in another way — the methods it does use.
 */
export interface GoogleFailure {
  code: string;
  methods: string[];
}

let failure: GoogleFailure | null = null;

export function recordGoogleFailure(f: GoogleFailure): void {
  failure = f;
}

/** The pending failure, once — the page that shows it clears it. */
export function takeGoogleFailure(): GoogleFailure | null {
  const f = failure;
  failure = null;
  return f;
}
