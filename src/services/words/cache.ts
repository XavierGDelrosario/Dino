// =========================================================
// In-memory client cache for the global `words` dictionary reads.
//
// WHY this is safe to cache client-side (and `user_words` is NOT): `words` is the
// SHARED, verified dictionary cache — READ-ONLY to clients (only the edge function
// writes it) and effectively immutable within a browser session. The only way a
// row changes is a server-side re-projection (a deferred admin feature), and even
// then the change is benign (a better reading/ranking, never a wrong meaning). So
// a session-lifetime memo can never serve user-visible-wrong data; the worst case
// is a slightly stale furigana until the next page load clears it.
//
// `user_words` (a user's vocabulary + mastery) mutates constantly — save, edit,
// delete, every review changes confidence — so it is deliberately NOT cached
// here; those reads stay live (see useLists' read-after-mutation).
//
// The cache is keyed by (input, source, target) — the SEARCH term the caller
// passed, matching how repository.ts queries `words` (.eq("input", …)). It stores
// the full sense list for a key (verified-first, the same order the DB returns).
//
// NEGATIVE results are never cached: an empty read means "not in the cache yet",
// and the caller then asks the edge function, which POPULATES `words`. Caching the
// empty would wrongly mask that fresh data for the rest of the session.
//
// The ONE exception is the dictionary-miss set at the bottom — a different kind of
// negative, and deliberately a separate store rather than a relaxation of the rule
// above. See its own note.
// =========================================================

import type { LangCode } from "../language";
import type { Word } from "./repository";
import { nfc } from "../../lib/text";

/** Soft cap so a very long session can't grow the memo without bound. Oldest
 *  entries evict first (the Map preserves insertion order). */
const MAX_ENTRIES = 2000;

const store = new Map<string, Word[]>();

// JSON.stringify of the tuple: unambiguous (each part is quoted/escaped) and plain
// ASCII, so distinct keys can't collide and the source stays text (no separator
// control chars). NFC-normalize the input here too — the single chokepoint that
// GUARANTEES a consistent key (composed vs decomposed Japanese can't fork it),
// regardless of whether a caller remembered to normalize. Idempotent + cheap.
const keyFor = (input: string, source: LangCode, target: LangCode) =>
  JSON.stringify([source, target, nfc(input)]);

/** Cached senses for a lookup, or undefined if not memoized yet (≠ "no senses"). */
export function getCachedSenses(
  input: string,
  source: LangCode,
  target: LangCode,
): Word[] | undefined {
  return store.get(keyFor(input, source, target));
}

/** Memoize the senses for a lookup. No-op for an empty list (see NEGATIVE above). */
export function setCachedSenses(
  input: string,
  source: LangCode,
  target: LangCode,
  words: Word[],
): void {
  if (words.length === 0) return;
  const key = keyFor(input, source, target);
  store.delete(key); // re-insert so a refreshed key counts as most-recent
  store.set(key, words);
  if (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Dictionary misses — for PROBES only.
//
// The reader guesses at compounds kuromoji may have over-segmented (柔軟 ＋ 剤 →
// could 柔軟剤 be a word?) and asks the DICTIONARY-ONLY path. Most guesses are
// wrong, and re-analyzing the same text re-asks every one of them.
//
// Why this negative IS cacheable when the one above isn't: a normal empty read
// means "not fetched yet", and the follow-up edge call POPULATES `words`, so the
// emptiness is temporary. A dictionary-only probe miss is the authoritative
// answer — the dictionary has no such entry — and that call populates NOTHING
// (no MT write by design). So it cannot become true later in the session, and
// remembering it masks nothing.
//
// Kept in memory, NOT the DB, on purpose: recomputing is one free batched lookup,
// whereas a stored negative would go stale the moment JMdict is re-ingested (a row
// claiming 柔軟剤 isn't a word would outlive the ingest that adds it) and would need
// the very invalidation machinery that the `words` cache already makes expensive.
// A session-lifetime memo drops the staleness problem entirely: a page load is the
// invalidation.
//
// USE ONLY from the probe path. Consulting this from a normal lookup would suppress
// a word the edge could still resolve via MT — the exact mistake the rule above
// exists to prevent.
// ---------------------------------------------------------------------------

/** Separate cap: probe misses are far more numerous than hits (most guesses are
 *  wrong), so they must not evict real cached senses. */
const MAX_MISSES = 4000;

const misses = new Set<string>();

/** Has the dictionary already told us this exact term has no entry this session? */
export function isKnownDictionaryMiss(
  input: string,
  source: LangCode,
  target: LangCode,
): boolean {
  return misses.has(keyFor(input, source, target));
}

/** Record that a DICTIONARY-ONLY lookup found no entry for this term. */
export function markDictionaryMiss(
  input: string,
  source: LangCode,
  target: LangCode,
): void {
  const key = keyFor(input, source, target);
  misses.delete(key); // re-insert so a re-seen key counts as most-recent
  misses.add(key);
  if (misses.size > MAX_MISSES) {
    const oldest = misses.values().next().value;
    if (oldest !== undefined) misses.delete(oldest);
  }
}

/** Test hook: drop all memoized entries (the cache is module-global). */
export function __clearWordsCache(): void {
  store.clear();
  misses.clear();
}
