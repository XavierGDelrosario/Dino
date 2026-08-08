// The cache-freshness contract for `words` (a lazy cache projected from JMdict/WordNet).
//
// A row stamped below CURRENT_PROJECTION_VERSION is a cache MISS, so the lookup
// re-projects it; the upsert on `dictionary_ref` UPDATEs in place (same word_id), so
// `user_words.dictionary_word_id` never dangles and nothing is deleted.
//
// MT rows are gated too. A stale MT row is a miss, which buys a FREE dictionary
// re-check; if the dictionary still has nothing the edge re-serves the MT text it
// already paid for and re-stamps it (reviveMtRows) — a bump costs zero Google calls.
//
// Bump when a cached row would otherwise serve a STALE ANSWER. Do NOT bump when the row
// can be corrected in place (e.g. an ingest that backfills `words` directly) — a bump
// stales the whole cache at once and re-resolves it on first access.
//
// MIRRORED in supabase/functions/translate/index.ts (separate Deno runtime, can't import
// this). Bump BOTH; tests/services/projection-version.test.ts fails if they drift.

/** Rows stamped below this are stale: re-project them instead of serving them. */
export const CURRENT_PROJECTION_VERSION = 13;

/** PostgREST filter for "safe to serve from cache" — MT rows included (see header). */
export const FRESH = `projection_version.gte.${CURRENT_PROJECTION_VERSION}`;
