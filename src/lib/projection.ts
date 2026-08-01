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
// v9 (20260740): the proficiency band falls back to the entry's KANJI writing when
// the shown writing has none, so a "usually kana" headword (こと, いる, ため) stops
// reading as unlevelled. That migration also backfills the cached NULLs directly —
// the bump alone would only heal words somebody happens to look up again, and Lists
// reads a saved word's band off `words` without ever consulting the dictionary.
//
// v10 (20260742): EN→JA is ranked by how PRIMARY the matching gloss is inside the
// entry, and the edge merge leads with the gloss search instead of WordNet — so a
// cached EN→JA row carries the old, wrong primary sense (run→実行, light→簡単) and has
// to re-project.
//
// v11 (20260747): `wordnet_en_ja_lookup` now ranks by the same headline_rank the gloss
// search uses — how PRIMARY the English word is inside the entry — instead of by
// Japanese corpus frequency, which had every lemma touching the top synset tied at
// rank 0 and let 言う (freq 568) beat 走る (446) for "run".
//   ⚠️ SCOPE, measured on prod rather than assumed: the edge merge ALREADY demotes
//   WordNet to last (intersection → gloss → WordNet, since 2026-07-31), so the TOP
//   result is unchanged — 0 of 30 sampled words changed at position 1, because the
//   gloss path answers for all of them and leads. What changes is the WordNet-only
//   TAIL: 10 of 30 changed within the top 3, 20 of 30 at some position. That tail is
//   also the only thing WordNet decides outright, for words the gloss search misses
//   entirely. Cached rows carry the old tail order until re-projected — which is what
//   this bump is for. Do not read the migration's own "17/30 → 30/30" as a user-facing
//   number: that was the raw SQL function in isolation, before the merge demotes it.
//
// v12 (2026-08-01): EN→JA function words are TERMINAL and an inflected verb prefers
// verb senses. Unlike v11 this changes WHICH senses exist, not just their order —
// prod had cached `an` → 1, `is` → ある, `my` → マイ, and those rows are already
// stamped v11 so the gate considers them fresh. A row whose word no longer projects
// simply stops being served (it lingers as dead storage until the deferred sweep);
// `worked` re-projects with 働く ahead of 仕事.
//
// MIRRORED in supabase/functions/translate/index.ts (separate Deno runtime — it can't
// import this file). tests/services/projection-version.test.ts fails if the two drift.
// Bump BOTH whenever the projection changes; the bump is what makes old rows stale.
// =========================================================

/** Rows stamped below this are stale: re-project them instead of serving them. */
export const CURRENT_PROJECTION_VERSION = 12;

/**
 * PostgREST filter for "this row is safe to serve from cache" — a projection at the
 * CURRENT version. Applies to MT rows too (see the header): a stale MT row is a miss, so
 * the edge re-checks the dictionary before falling back on the cached MT text.
 */
export const FRESH = `projection_version.gte.${CURRENT_PROJECTION_VERSION}`;
