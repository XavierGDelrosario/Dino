// State that survives a tab switch.
//
// The tab nav (HomeView) conditionally renders, so switching tabs UNMOUNTS the
// view and drops every hook's state — you lose what you typed in Translate and
// the filters you set in Lists. This holds those values in a module-scope cache
// that outlives the component, so remounting restores them.
//
// ONLY for state that CANNOT BE WRONG if the world changed while you were away:
// text the user typed, a sort order, which tab is open. Do NOT use it for a
// client mirror of server data (`useTranslate`'s saved/confidence maps, the
// words/lists arrays) — unmounting is what currently guarantees those re-read
// fresh, and a stale mirror shows a word as saved after it was deleted
// elsewhere. That's a cache with no invalidation path; we already have one of
// those in `words` (see projection_version) and don't want a second.
//
// Values are held as-is (no serialization), so Map/Set/undefined all survive.
// Nothing here outlives a page reload — that's deliberate, not a gap to fill.
import { useEffect, useState } from "react";

const cache = new Map<string, unknown>();
// Whose values are in the cache. The views are keyed on userId so they remount
// on a sign-in/out/upgrade; the cache has to reset with them or the next user
// inherits the last one's input and filters.
let owner: string | null = null;

function scope(userId: string) {
  if (owner !== userId) {
    cache.clear();
    owner = userId;
  }
}

/** Drop everything. Tests only — module state is shared across cases otherwise. */
export function resetStickyState() {
  cache.clear();
  owner = null;
}

/**
 * `useState`, but the value survives unmount for the given user. `key` is
 * namespaced per user internally; pass a stable, view-scoped name
 * ("lists.sort", "translate.input").
 */
export function useStickyState<T>(userId: string, key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    scope(userId);
    return cache.has(key) ? (cache.get(key) as T) : initial;
  });

  useEffect(() => {
    scope(userId);
    cache.set(key, value);
  }, [userId, key, value]);

  return [value, setValue] as const;
}
