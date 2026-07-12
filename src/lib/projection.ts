// =========================================================
// The projection version — the cache-freshness contract for `words`.
//
// `words` is a LAZY CACHE projected from JMdict/WordNet. Improving the SOURCE (a
// re-ingest) or the PROJECTION (jmdict_lookup, the edge's toWord: readings, headword,
// uk, frequency, proficiency, sense ORDER) leaves already-cached rows STALE — and a
// cache HIT returns them as-is, so the improvement never reaches a word anyone has
// already looked up. That is exactly what happened in prod: ~4.7k of ~5k cached rows
// were projected by older logic (versions 3–6) and were being served forever, e.g.
// EN→JA rows still carrying the pre-v7 sense order (the wrong primary).
//
// The stamp itself already existed (the edge writes projection_version on every row).
// What was missing was the READ side: nothing ever compared it. So a row is now only a
// cache hit if it is CURRENT — a stale row is a MISS, and the miss re-projects it. The
// re-projection UPSERTs on `dictionary_ref`, so the row is UPDATED IN PLACE (same
// word_id) and `user_words.dictionary_word_id` keeps pointing at it. Nothing is
// deleted; the cache heals itself as words are used.
//
// MT rows are EXEMPT (see isFreshOrMt): they are not projections of anything, so
// "re-projecting" one would just re-call the PAID Google endpoint and rewrite the same
// text. A version bump must never turn the MT cache into a spend event.
//
// MIRRORED in supabase/functions/translate/index.ts (separate Deno runtime — it can't
// import this file). tests/services/projection-version.test.ts fails if the two drift.
// Bump BOTH whenever the projection changes; the bump is what makes old rows stale.
// =========================================================

/** Rows stamped below this are stale: re-project them instead of serving them. */
export const CURRENT_PROJECTION_VERSION = 7;

/**
 * PostgREST `or` filter for "this row is safe to serve from cache".
 *
 * Fresh JMdict/WordNet projection, OR an MT fallback row (`dictionary_ref` = `mt:…`),
 * which has no projection to be stale against and costs money to redo.
 */
export const FRESH_OR_MT = `projection_version.gte.${CURRENT_PROJECTION_VERSION},dictionary_ref.like.mt:*`;
