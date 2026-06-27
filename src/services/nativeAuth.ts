// =========================================================
// Native (Capacitor/iOS) OAuth deep-link plumbing.
//
// In the browser, Supabase OAuth is a full-page redirect: signInWithOAuth sends
// the user to Google and Google redirects back to the app ORIGIN, where the
// client (detectSessionInUrl) picks the session out of the URL. Inside a
// Capacitor WebView there is no such navigable origin — a redirect escapes to
// Safari and never returns. So on native we do the canonical custom-scheme flow:
//
//   1. signInWithGoogle / linkGoogle (services/session) call signInWithOAuth with
//      skipBrowserRedirect + redirectTo = NATIVE_OAUTH_REDIRECT, then open the
//      returned provider URL in an in-app browser (@capacitor/browser).
//   2. Google → Supabase redirects to NATIVE_OAUTH_REDIRECT (our custom URL
//      scheme). iOS hands the URL back to the app, firing `appUrlOpen` below.
//   3. We pull the PKCE `code` off the URL and exchangeCodeForSession — which runs
//      in the SAME WebView that started the flow, so the PKCE verifier in
//      localStorage is available. onAuthStateChange (useSession) then sees SIGNED_IN.
//
// Requires: the custom scheme registered in ios Info.plist (CFBundleURLTypes) and
// NATIVE_OAUTH_REDIRECT added to Supabase Auth → URL Configuration (prod) /
// config.toml additional_redirect_urls (local).
// =========================================================

import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { supabase } from "../config/supabaseClient";

/** The custom-scheme URL Google/Supabase redirects to after a native OAuth login.
 *  The scheme MUST match the app bundle id registered in Info.plist. */
export const NATIVE_OAUTH_REDIRECT = "com.xaviergdelrosario.dino://auth-callback";

/** True when running inside the Capacitor native shell (iOS), false in the browser. */
export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Registers the `appUrlOpen` listener that completes a native OAuth login. No-op
 * (returns an empty cleanup) in the browser. Call once from the session bootstrap;
 * the returned function removes the listener on unmount.
 */
export async function registerNativeAuthListener(): Promise<() => void> {
  if (!isNative()) return () => {};

  const handle = await App.addListener("appUrlOpen", async ({ url }) => {
    // e.g. com.xaviergdelrosario.dino://auth-callback?code=<pkce-code>
    //  (or ...?error=access_denied&error_description=... on a cancel/failure)
    try {
      const parsed = new URL(url);
      const code = parsed.searchParams.get("code");
      const errorDescription = parsed.searchParams.get("error_description");
      if (errorDescription) {
        console.error("Native OAuth returned an error:", errorDescription);
      } else if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) console.error("exchangeCodeForSession failed:", error);
      }
    } catch (e) {
      console.error("Failed to handle native auth deep link:", e);
    } finally {
      // Close the in-app browser whether we succeeded or not.
      await Browser.close().catch(() => {});
    }
  });

  return () => {
    handle.remove().catch(() => {});
  };
}

/**
 * Runs `onDismiss` ONCE when the in-app OAuth browser closes — whether by our
 * redirect handler (a completed login) or by the user CANCELLING the sheet. The
 * cancel case is the important one: no deep link fires, so a caller that disabled
 * its UI before opening the browser (AuthPage's `busy`) would stay stuck. The
 * listener auto-removes after firing; the returned function removes it early (for
 * the caller's error path, before any browser opened). No-op on web.
 */
export async function onOAuthBrowserDismissed(onDismiss: () => void): Promise<() => void> {
  if (!isNative()) return () => {};
  const handle = await Browser.addListener("browserFinished", () => {
    handle.remove().catch(() => {});
    onDismiss();
  });
  return () => {
    handle.remove().catch(() => {});
  };
}
