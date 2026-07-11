import { ServiceError, type ServiceErrorKind } from "../services/errors";

// User-facing copy per domain error kind. Deliberately generic — we render from
// the `kind`, never the raw provider `.message` (which can be a Postgres SQLSTATE
// string like `duplicate key value violates unique constraint "uq_…"`). The raw
// `.message`/`.code` stay on the ServiceError for telemetry/logging.
const COPY_BY_KIND: Record<ServiceErrorKind, string> = {
  conflict: "That already exists.",
  not_found: "We couldn't find that.",
  permission: "You don't have permission to do that.",
  validation: "That request wasn't valid.",
  unknown: "Something went wrong. Please try again.",
};

// Best-effort human-readable string from a thrown value, safe to render in the UI.
//
// - A `ServiceError` that carries a provider `code` (SQLSTATE) came from the DB, so
//   its `.message` is raw internals — render friendly copy keyed on its `kind`.
// - A `ServiceError` with NO code was authored in app code (e.g. an input check),
//   so its `.message` is intentional user copy — keep it.
// - Anything else (Auth errors, network) keeps its message: Supabase Auth messages
//   are user-meaningful ("Invalid login credentials") and not DB internals.
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
