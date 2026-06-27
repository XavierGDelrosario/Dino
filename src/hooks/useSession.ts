// Bootstraps the anonymous guest session once on app start, then tracks the live
// auth identity (guest vs permanent account) so the UI updates when the user
// upgrades / signs in / signs out (see services/session).
import { useEffect, useState } from "react";
import { ensureSession, getAuthStatus, type AuthStatus } from "../services/session";
import { registerNativeAuthListener } from "../services/nativeAuth";
import { supabase } from "../config/supabaseClient";

export interface SessionState {
  userId: string | null;
  /** Real email once upgraded to a permanent account; null while a guest. */
  email: string | null;
  /** true until the user creates/links a permanent account. */
  isAnonymous: boolean;
  /** true while the user is in a password-recovery session (followed a reset link)
   *  — the app shows the set-new-password form until they finish (clearRecovery). */
  recovering: boolean;
  clearRecovery: () => void;
  loading: boolean;
  error: Error | null;
}

/** Supabase throws plain {message, code, status} objects, not Errors — surface
 *  their real content instead of the useless "[object Object]". */
function describeError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const parts = [o.message, o.error_description, o.error, o.code, o.status]
      .filter((v) => v !== undefined && v !== null && v !== "")
      .join(" · ");
    return new Error(parts || JSON.stringify(o));
  }
  return new Error(String(e));
}

/** True when the page was opened from a password-RESET link (implicit flow puts
 *  `type=recovery` in the URL hash). Supabase emits its PASSWORD_RECOVERY event from
 *  a setTimeout INSIDE client init, which can fire BEFORE this hook's
 *  onAuthStateChange listener attaches — so the event is missed and the user just
 *  ends up logged in with no reset prompt. Reading the URL synchronously in the
 *  state initializer (below) catches it: the hash is still present during the first
 *  React render, before supabase strips it via replaceState. */
function isRecoveryUrl(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.location.hash.includes("type=recovery") ||
    window.location.search.includes("type=recovery")
  );
}

export function useSession(): SessionState {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  // Seed from the URL so a reset link reliably opens the set-new-password takeover
  // even if the PASSWORD_RECOVERY event is missed; the listener below still sets it
  // too (belt-and-suspenders, and covers the PKCE/native path).
  const [recovering, setRecovering] = useState(isRecoveryUrl);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;

    // 0. Native (iOS): listen for the OAuth deep-link callback so Google sign-in can
    //    complete in the app. No-op in the browser. Cleaned up on unmount.
    let removeNativeAuth = () => {};
    registerNativeAuthListener().then((remove) => {
      if (active) removeNativeAuth = remove;
      else remove();
    });

    // 1. Bootstrap: sign in anonymously if needed + ensure the public.users row.
    ensureSession()
      .then(() => getAuthStatus())
      .then((s) => active && s && setStatus(s))
      .catch((e) => {
        console.error("ensureSession failed:", e); // full object in DevTools
        if (active) setError(describeError(e));
      });

    // 2. Keep the identity live across upgrade (USER_UPDATED) / sign-in / sign-out,
    //    and catch PASSWORD_RECOVERY (the user followed a reset link).
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      const u = session?.user;
      if (u) {
        const isAnonymous = (u as { is_anonymous?: boolean }).is_anonymous === true;
        setStatus({ userId: u.id, email: isAnonymous ? null : u.email || null, isAnonymous });
      } else if (event === "SIGNED_OUT") {
        // No session (explicit sign-out, token expiry, or another-tab sign-out).
        // Self-heal into a fresh guest so the UI never sits on a dead identity that
        // 401/403s every read/write. ensureSession dedupes concurrent calls, and its
        // SIGNED_IN event repopulates status via the branch above.
        ensureSession().catch((e) => active && setError(describeError(e)));
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
      removeNativeAuth();
    };
  }, []);

  return {
    userId: status?.userId ?? null,
    email: status?.email ?? null,
    isAnonymous: status?.isAnonymous ?? true,
    recovering,
    clearRecovery: () => setRecovering(false),
    loading: status === null && error === null,
    error,
  };
}
