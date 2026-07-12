// =========================================================
// CAPTCHA tokens for the auth endpoints Supabase can gate (2026-06-28 audit, MED).
//
// WHY: the IP rate-limit (30 anon sign-ins/hour/IP) does not stop a rotating-IP
// sybil from bloating auth.users — every visitor gets a real anonymous auth user at
// bootstrap, so the sign-up surface is the whole public site. Supabase's own
// anonymous-auth guidance is "enable invisible CAPTCHA or Cloudflare Turnstile".
//
// PROVIDER: Cloudflare Turnstile, INVISIBLE widget type (the sitekey carries the
// type — pick "Invisible" in the Turnstile dashboard). Invisible matters: the anon
// token is minted during app bootstrap, where there is no UI moment to show a
// checkbox, so an interactive challenge would deadlock the first paint. Free +
// unlimited, and we already host on Cloudflare.
//
// OFF BY DEFAULT: with no VITE_TURNSTILE_SITE_KEY, getCaptchaToken() resolves to
// undefined and the auth calls pass no token — exactly today's behavior. The token
// is only ever REQUIRED by the server, so the switch that turns captcha on is the
// project's [auth.captcha] setting, not this file. Keep the two in step: enabling
// the project setting without shipping a key here locks everyone out, and vice
// versa a key with the project setting off just mints tokens nobody checks.
//
// NATIVE (iOS/Capacitor): Turnstile does NOT support the `capacitor://` scheme the
// WebView runs on, so a native build CANNOT mint a token. Do not enable captcha on
// a project a native build points at (today `build-ios.sh` defaults to PROD) —
// see docs/TODO.md.
//
// LOCAL VERIFY: Cloudflare's dummy keys work on ANY hostname, incl. localhost:
//   .env                 VITE_TURNSTILE_SITE_KEY=1x00000000000000000000BB  (invisible, always passes)
//   supabase/config.toml [auth.captcha] enabled/provider/secret (see that file)
// Swap the sitekey to 2x00000000000000000000BB (invisible, always FAILS) to prove
// the failure path really rejects.
// =========================================================

import { ServiceError } from "./errors";

/** The Turnstile sitekey. Unset (the default) = captcha disabled client-side. */
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Give up on a token rather than hang the app forever behind a blocked/slow CDN. */
const TOKEN_TIMEOUT_MS = 15_000;

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback": () => void;
      "timeout-callback"?: () => void;
    },
  ): string | undefined;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** True when a sitekey is configured — i.e. this build mints captcha tokens. */
export function captchaEnabled(): boolean {
  return Boolean(SITE_KEY);
}

// The <script> is injected once per page; concurrent callers share the load.
let scriptLoad: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  return (scriptLoad ??= new Promise<TurnstileApi>((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new ServiceError("Captcha failed to load", "unknown"));
    };
    script.onerror = () => reject(new ServiceError("Captcha failed to load", "unknown"));
    document.head.appendChild(script);
  }).catch((e) => {
    scriptLoad = null; // a network blip shouldn't poison every later attempt
    throw e;
  }));
}

/**
 * Mint a fresh captcha token for ONE auth call.
 *
 * OUTPUT: the token, or undefined when captcha is disabled (no sitekey) or there is
 * no DOM (tests / any non-browser caller) — callers pass it straight through as
 * `options.captchaToken`, where undefined means "don't send one".
 * THROWS: ServiceError if a token was expected but couldn't be obtained (script
 * blocked, challenge failed, timed out) — the auth call would be rejected anyway,
 * so failing here gives the clearer message.
 *
 * Tokens are single-use and short-lived, so this renders a throwaway widget per
 * call rather than caching one. The widget is invisible; it lives off-screen (NOT
 * display:none, which can stop it from running) and is removed in a finally.
 */
export async function getCaptchaToken(): Promise<string | undefined> {
  if (!SITE_KEY) return undefined;
  if (typeof document === "undefined") return undefined;

  const turnstile = await loadTurnstile();

  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-9999px";
  container.style.top = "0";
  document.body.appendChild(container);

  let widgetId: string | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      const fail = () => reject(new ServiceError("Captcha check failed", "permission"));
      const timer = setTimeout(
        () => reject(new ServiceError("Captcha check timed out", "unknown")),
        TOKEN_TIMEOUT_MS,
      );
      const settle = (fn: (v: string) => void) => (token: string) => {
        clearTimeout(timer);
        fn(token);
      };
      widgetId = turnstile.render(container, {
        sitekey: SITE_KEY,
        callback: settle(resolve),
        "error-callback": () => {
          clearTimeout(timer);
          fail();
        },
        "timeout-callback": () => {
          clearTimeout(timer);
          fail();
        },
      });
    });
  } finally {
    if (widgetId) turnstile.remove(widgetId);
    container.remove();
  }
}
