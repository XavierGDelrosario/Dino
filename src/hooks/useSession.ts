// Bootstraps the anonymous guest session once on app start (see services/session).
// Every data call needs the userId it returns, so views wait on this first.
import { useEffect, useState } from "react";
import { ensureSession } from "../services/session";

export interface SessionState {
  userId: string | null;
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
  const [userId, setUserId] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    ensureSession()
      .then((id) => active && setUserId(id))
      .catch((e) => {
        console.error("ensureSession failed:", e); // full object in DevTools
        if (active) setError(describeError(e));
      });
    return () => {
      active = false;
    };
  }, []);

  return { userId, loading: userId === null && error === null, error };
}
