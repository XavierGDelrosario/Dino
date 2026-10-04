// =========================================================
// Google sign-in WITHOUT the round-trip through Supabase's domain (web only).
//
// WHY: the redirect flow (session.ts startOAuth) sends the user to Google with a
// redirect URI on `<ref>.supabase.co`, so Google's consent screen reads "continue to
// <ref>.supabase.co" — a string no user recognises. The fixes Supabase offers are a
// paid custom domain or this: let GOOGLE hand the browser an ID token directly
// (Google Identity Services), then give that token to Supabase
// (`signInWithIdToken` / `linkIdentity`). No redirect URI is involved, so Google names
// the page's own origin, and there is no page reload — the result comes back to the
// caller as a value, which also removes the URL-error bookkeeping of the redirect flow.
//
// THE BUTTON IS GOOGLE'S. GIS only issues a token from the button IT renders (an
// iframe); a custom button cannot trigger it. So this module mounts their button into
// a container and reports the credential.
//
// NONCE: Google is given the SHA-256 of a random value and stamps it into the token;
// Supabase is given the RAW value and checks the two match. One nonce per mount, so a
// token can't be replayed against a later session.
//
// OFF WITHOUT A CLIENT ID: no VITE_GOOGLE_CLIENT_ID → googleButtonEnabled() is false
// and callers keep the redirect flow. It must be the SAME web client the Supabase
// Google provider is configured with (the token's audience is checked server-side),
// and the page's origin must be in that client's "Authorised JavaScript origins".
//
// NATIVE (iOS/Capacitor): GIS does not run under `capacitor://`, so native keeps the
// in-app-browser redirect flow.
// =========================================================

import { isNative } from "./nativeAuth";
import { ServiceError } from "./errors";

/** The Google OAuth WEB client id. Unset (the default) = this path is off. */
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

const SCRIPT_URL = "https://accounts.google.com/gsi/client";

/** What Supabase needs to accept a Google sign-in: the ID token + the raw nonce. */
export interface GoogleCredential {
  token: string;
  nonce: string;
}

interface GisIdApi {
  initialize(options: {
    client_id: string;
    callback: (response: { credential?: string }) => void;
    nonce: string;
    ux_mode: "popup";
  }): void;
  renderButton(
    container: HTMLElement,
    options: {
      type: "standard";
      theme: "outline" | "filled_black";
      size: "large";
      text: "continue_with";
      shape: "rectangular";
      logo_alignment: "center";
      width: number;
      locale: string;
    },
  ): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GisIdApi } };
  }
}

/** True when this build can mount Google's own button (web + a client id). */
export function googleButtonEnabled(): boolean {
  return Boolean(CLIENT_ID) && typeof document !== "undefined" && !isNative();
}

/** A random nonce and the SHA-256 hex digest Google is given in its place. */
export async function makeNonce(): Promise<{ raw: string; hashed: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = btoa(String.fromCharCode(...bytes));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hashed = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return { raw, hashed };
}

// The <script> is injected once per page; concurrent callers share the load.
let scriptLoad: Promise<GisIdApi> | null = null;

function loadGis(): Promise<GisIdApi> {
  return (scriptLoad ??= new Promise<GisIdApi>((resolve, reject) => {
    const ready = () => window.google?.accounts?.id;
    const existing = ready();
    if (existing) return resolve(existing);
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      const api = ready();
      if (api) resolve(api);
      else reject(new ServiceError("Google sign-in failed to load", "unknown"));
    };
    script.onerror = () => reject(new ServiceError("Google sign-in failed to load", "unknown"));
    document.head.appendChild(script);
  }).catch((e) => {
    scriptLoad = null; // a blocked or flaky load shouldn't poison every later attempt
    throw e;
  }));
}

// Google's button takes a pixel width in this range.
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;

/**
 * Render Google's "Continue with Google" button into `container` and call
 * `onCredential` when the user completes the popup.
 *
 * THROWS: ServiceError when the script can't load (ad-blocker, offline) — the caller
 * falls back to the redirect flow. A user who closes the popup produces no callback
 * at all, by Google's design.
 */
export async function mountGoogleButton(
  container: HTMLElement,
  options: {
    onCredential: (credential: GoogleCredential) => void;
    theme: "light" | "dark";
    locale: string;
    /** True once the caller no longer wants the button (its container unmounted
     *  while the script was loading) — nothing is initialized or rendered then. */
    cancelled?: () => boolean;
  },
): Promise<void> {
  if (!CLIENT_ID) throw new ServiceError("Google sign-in is not configured", "unknown");
  const [gis, nonce] = await Promise.all([loadGis(), makeNonce()]);
  if (options.cancelled?.()) return;
  gis.initialize({
    client_id: CLIENT_ID,
    nonce: nonce.hashed,
    ux_mode: "popup",
    callback: (response) => {
      if (response.credential) options.onCredential({ token: response.credential, nonce: nonce.raw });
    },
  });
  gis.renderButton(container, {
    type: "standard",
    theme: options.theme === "dark" ? "filled_black" : "outline",
    size: "large",
    text: "continue_with",
    shape: "rectangular",
    logo_alignment: "center",
    width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(container.clientWidth))),
    locale: options.locale,
  });
}
