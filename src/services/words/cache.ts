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
// =========================================================

import type { LangCode } from "../language";
import type { Word } from "./repository";

/** Soft cap so a very long session can't grow the memo without bound. Oldest
 *  entries evict first (the Map preserves insertion order). */
const MAX_ENTRIES = 2000;

const store = new Map<string, Word[]>();

// JSON.stringify of the tuple: unambiguous (each part is quoted/escaped) and plain
// ASCII, so distinct keys can't collide and the source stays text (no separator
// control chars).
const keyFor = (input: string, source: LangCode, target: LangCode) =>
  JSON.stringify([source, target, input]);

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

/** Test hook: drop all memoized entries (the cache is module-global). */
export function __clearWordsCache(): void {
  store.clear();
}
