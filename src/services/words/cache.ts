// In-memory client cache for the global `words` dictionary reads.
//
// Safe to cache (where `user_words` is NOT) because `words` is READ-ONLY to clients and
// effectively immutable within a session: the only way a row changes is a server-side
// re-projection, and that change is benign — a better reading or ranking, never a wrong
// meaning. `user_words` mutates constantly (every save, edit and review), so it stays
// live. Worst case here is a slightly stale furigana until the next page load.
//
// Keyed by (input, source, target) — the SEARCH term, matching how repository.ts
// queries `words` — and holds the full sense list in the order the DB returned it.
//
// NEGATIVE results are never cached: an empty read means "not in the cache yet", and
// the caller then asks the edge function, which POPULATES `words`. Caching the empty
// would mask that fresh data for the rest of the session. The dictionary-miss set at
// the bottom is a different kind of negative — see its own note.

import type { LangCode } from "../language";
import type { Word } from "./repository";
import { nfc } from "../../lib/text";

/** Soft cap so a very long session can't grow the memo without bound. Oldest
 *  entries evict first (the Map preserves insertion order). */
const MAX_ENTRIES = 2000;

const store = new Map<string, Word[]>();

// JSON.stringify of the tuple: each part is quoted/escaped, so distinct keys can't
// collide and no separator control char is needed. NFC here is the single chokepoint
// that GUARANTEES a consistent key, whether or not a caller remembered to normalize.
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
// The reader guesses at compounds kuromoji may have over-segmented ("could 柔軟剤 be a
// word?") via the DICTIONARY-ONLY path. Most guesses are wrong, and re-analyzing the
// same text re-asks every one of them.
//
// Why THIS negative is cacheable when the one above isn't: a normal empty read is
// temporary (the follow-up edge call populates `words`), whereas a dictionary-only
// probe miss is the authoritative answer and that call populates NOTHING. It can't
// become true later in the session, so remembering it masks nothing.
//
// In memory, NOT the DB: recomputing is one free batched lookup, while a stored
// negative would go stale the moment JMdict is re-ingested and would need the very
// invalidation machinery the `words` cache already makes expensive. A page load is the
// invalidation.
//
// USE ONLY from the probe path — consulting it from a normal lookup would suppress a
// word the edge could still resolve via MT.
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
