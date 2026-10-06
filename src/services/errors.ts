// =========================================================
// Domain error taxonomy for the service layer.
//
// Services talk to Supabase (PostgREST + Auth), which surfaces raw
// `PostgrestError` / `AuthError` objects carrying Postgres SQLSTATEs. Leaking
// those upward forces callers (hooks/UI) to branch on database internals. Instead
// every service failure becomes a `ServiceError` with a stable `kind` the UI can
// switch on (e.g. show "already in your lists" for a conflict), while PRESERVING
// the original `message` and `code` for logging/debugging.
//
// Usage: wrap a Supabase result at the boundary —
//   const { data, error } = await supabase.from(...)...;
//   if (error) throw toServiceError(error);
//   // or, requiring a row:  return unwrap({ data, error }, "Failed to create X");
// =========================================================

import { notifyRowLimit, parseRowLimit, type RowLimitHit } from "./rowLimit";

/** Coarse, UI-switchable failure categories. */
export type ServiceErrorKind =
  | "conflict" // unique violation — the thing already exists
  | "not_found" // a required row was absent
  | "permission" // RLS / insufficient privilege — not yours / not allowed
  | "validation" // a constraint (check/FK/not-null) or app-side input check failed
  | "limit" // a per-user row cap (user_rows_cap, 20260785) — `limit` says which
  | "unknown"; // anything unmapped (network, unexpected provider error)

// Postgres SQLSTATE → domain kind. PGRST116 is PostgREST's "no rows for single()".
const KIND_BY_CODE: Record<string, ServiceErrorKind> = {
  "23505": "conflict", // unique_violation
  "23503": "validation", // foreign_key_violation
  "23502": "validation", // not_null_violation
  "23514": "validation", // check_violation
  "42501": "permission", // insufficient_privilege (RLS)
  PGRST116: "not_found",
};

/** A service-layer error with a UI-switchable `kind`; keeps the provider `code`. */
export class ServiceError extends Error {
  readonly kind: ServiceErrorKind;
  /** Underlying provider/SQLSTATE code, when there was one. */
  readonly code?: string;
  /** For kind "limit": the capped table and its ceiling. */
  readonly limit?: RowLimitHit;

  constructor(
    message: string,
    kind: ServiceErrorKind = "unknown",
    options?: { code?: string; cause?: unknown; limit?: RowLimitHit },
  ) {
    super(message);
    this.name = "ServiceError";
    this.kind = kind;
    this.code = options?.code;
    this.limit = options?.limit;
    // Set `cause` as a property (avoids depending on the ES2022 Error-cause ctor
    // signature across tsconfig targets).
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** Shape we duck-type out of a PostgrestError / AuthError. */
interface ProviderErrorLike {
  message?: string;
  code?: string;
}

/**
 * Maps any thrown/returned provider error into a `ServiceError`, preserving its
 * message and code and deriving a `kind` from the SQLSTATE. Pass-through if it is
 * already a ServiceError. `fallbackMessage` is used only when the error carries
 * no message (e.g. when called with a null error to signal "no row returned").
 */
export function toServiceError(error: unknown, fallbackMessage?: string): ServiceError {
  if (error instanceof ServiceError) return error;
  const e = (error ?? {}) as ProviderErrorLike;
  const code = typeof e.code === "string" ? e.code : undefined;
  const message = e.message ?? fallbackMessage ?? "Unexpected service error";
  // A per-user row cap is a check violation (23514) with a message user_rows_cap()
  // writes. It gets its own kind — AND is announced (services/rowLimit) so the app
  // shell can show the "create an account" prompt wherever the save was attempted.
  // The one side effect in this module, on purpose: it is the single boundary every
  // save passes through.
  const limit = code === "23514" ? parseRowLimit(e.message) : null;
  if (limit) {
    notifyRowLimit(limit);
    return new ServiceError(message, "limit", { code, cause: error, limit });
  }
  const kind: ServiceErrorKind = code ? KIND_BY_CODE[code] ?? "unknown" : "unknown";
  return new ServiceError(message, kind, { code, cause: error });
}

/**
 * Unwraps a Supabase `{ data, error }` result: throws a mapped `ServiceError` on
 * error, otherwise returns `data`. When `requiredMessage` is given, a null `data`
 * (no row) also throws — for the "expected exactly one row" write paths.
 */
export function unwrap<T>(
  result: { data: T | null; error: unknown },
  requiredMessage?: string,
): T {
  if (result.error) throw toServiceError(result.error, requiredMessage);
  if (requiredMessage !== undefined && result.data == null) {
    throw new ServiceError(requiredMessage, "not_found");
  }
  return result.data as T;
}
