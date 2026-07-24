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
// MT rows (`dictionary_ref` = `mt:…`) USED to be exempt from this gate, on the grounds
// that they project nothing and re-doing one costs money. But that made an MT answer
// PERMANENT: 接す was cached as Google's "Contact" and kept being served even after the
// dictionary learned to resolve it (via the 〜す→〜する lemma fallback), because the MT
// row was always a hit and the dictionary was never consulted again. So MT rows are now
// gated like everything else — and the spend concern is handled where it belongs, in the
// edge function: a stale MT row is a MISS, which buys a FREE dictionary re-check, and if
// the dictionary STILL has nothing the edge serves the MT text it already paid for and
// re-stamps it current (reviveMtRows). A version bump therefore costs zero Google calls.
//
// MIRRORED in supabase/functions/translate/index.ts (separate Deno runtime — it can't
// import this file). tests/services/projection-version.test.ts fails if the two drift.
// Bump BOTH whenever the projection changes; the bump is what makes old rows stale.
// =========================================================

/** Rows stamped below this are stale: re-project them instead of serving them. */
export const CURRENT_PROJECTION_VERSION = 8;

/**
 * PostgREST filter for "this row is safe to serve from cache" — a projection at the
 * CURRENT version. Applies to MT rows too (see the header): a stale MT row is a miss, so
 * the edge re-checks the dictionary before falling back on the cached MT text.
 */
export const FRESH = `projection_version.gte.${CURRENT_PROJECTION_VERSION}`;
