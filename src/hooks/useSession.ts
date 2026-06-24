// Bootstraps the anonymous guest session once on app start, then tracks the live
// auth identity (guest vs permanent account) so the UI updates when the user
// upgrades / signs in / signs out (see services/session).
import { useEffect, useState } from "react";
import { ensureSession, getAuthStatus, type AuthStatus } from "../services/session";
import { supabase } from "../config/supabaseClient";

export interface SessionState {
  userId: string | null;
  /** Real email once upgraded to a permanent account; null while a guest. */
  email: string | null;
  /** true until the user creates/links a permanent account. */
  isAnonymous: boolean;
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

export function useSession(): SessionState {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;

    // 1. Bootstrap: sign in anonymously if needed + ensure the public.users row.
    ensureSession()
      .then(() => getAuthStatus())
      .then((s) => active && s && setStatus(s))
      .catch((e) => {
        console.error("ensureSession failed:", e); // full object in DevTools
        if (active) setError(describeError(e));
      });

    // 2. Keep the identity live across upgrade (USER_UPDATED) / sign-in / sign-out.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      const u = session?.user;
      if (u) {
        const isAnonymous = (u as { is_anonymous?: boolean }).is_anonymous === true;
        setStatus({ userId: u.id, email: isAnonymous ? null : u.email || null, isAnonymous });
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return {
    userId: status?.userId ?? null,
    email: status?.email ?? null,
    isAnonymous: status?.isAnonymous ?? true,
    loading: status === null && error === null,
    error,
  };
}
