import { ServiceError, type ServiceErrorKind } from "../services/errors";

// User-facing copy per domain error kind. Deliberately generic, because the alternative
// is what used to happen: a PostgREST failure was rendered verbatim, so a user could be
// shown `duplicate key value violates unique constraint "uq_user_words_custom"` — which
// tells them nothing, and tells anyone else our schema. The raw `.message`/`.code` stay
// on the ServiceError for logging and telemetry; only the UI copy is replaced.
const COPY_BY_KIND: Record<ServiceErrorKind, string> = {
  conflict: "That already exists.",
  not_found: "We couldn't find that.",
  permission: "You don't have permission to do that.",
  validation: "That request wasn't valid.",
  unknown: "Something went wrong. Please try again.",
};

/**
 * Best-effort human-readable string from a thrown value, SAFE to render in the UI.
 *
 * The distinction that matters is who WROTE the message:
 * - A ServiceError carrying a provider `code` (a SQLSTATE) came from the database, so
 *   its message is internals → show friendly copy keyed on `kind`.
 * - A ServiceError with NO code was authored in app code (an input check, a quota
 *   message), so its message is intentional user copy → keep it. This is the seam a
 *   service uses when it has something specific and useful to say.
 * - Anything else keeps its message: Supabase Auth errors are user-meaningful
 *   ("Invalid login credentials") and are not schema internals.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof ServiceError) {
    return e.code ? COPY_BY_KIND[e.kind] : e.message;
  }
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message: unknown }).message;
    if (m !== undefined && m !== null && m !== "") return String(m);
  }
  return String(e);
}
