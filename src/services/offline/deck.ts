// The cached review deck — the one place this feature keeps a MIRROR of server data.
//
// `useStickyState`'s header states the house rule this breaks:
//
//   "Do NOT use it for a client mirror of server data … a stale mirror shows a word as
//    saved after it was deleted elsewhere. That's a cache with no invalidation path;
//    we already have one of those in `words` and don't want a second."
//
// That objection is right, so the mirror carries the invalidation path the sticky cache
// refuses to:
//
//   · a `fetchedAt` stamp and a TTL — past it the deck is treated as absent, not stale;
//   · keyed on userId, so a sign-in/out/upgrade cannot inherit the last user's cards;
//   · DISCARDED, never merged, the moment a live queue arrives — the server always wins;
//   · scoped to the review deck alone. Lists, `words` and the saved/confidence maps stay
//     live-read exactly as they are today.
//
// The deck is disposable by design: losing it costs a refetch. The pending-grade queue
// (queue.ts) is the opposite and must never be dropped — keep the two straight.

import type { OfflineStore } from "./store";
import type { ClockAnchor } from "./clock";
import type { ReviewQueueItem } from "../review";

/**
 * Two decks, because they answer different questions and must not overwrite each other:
 *   session — the last session dealt online, in whatever scope it had (ALL or one list).
 *   full    — a much deeper cut of the whole vocabulary's queue, fetched ahead of need
 *             (review.ts `refreshOfflineDeck`) so an offline learner has more than the
 *             one session they happened to open last.
 */
export type DeckSlot = "session" | "full";
const KEYS: Record<DeckSlot, string> = { session: "review-deck", full: "review-deck-full" };

/** How long a cached deck may be dealt from. A day's study is the use case; past that
 *  the ranking it was built from is too old to be honest about. */
export const DECK_TTL_MS = 36 * 60 * 60 * 1000;

interface CachedDeck {
  userId: string;
  listId: string | null;
  fetchedAt: number;
  anchor: ClockAnchor;
  items: ReviewQueueItem[];
}

export async function saveDeck(
  store: OfflineStore,
  deck: { userId: string; listId: string | null; anchor: ClockAnchor; items: ReviewQueueItem[] },
  slot: DeckSlot = "session",
): Promise<void> {
  await store.set<CachedDeck>(KEYS[slot], { ...deck, fetchedAt: deck.anchor.serverNow });
}

/**
 * The cached deck, or null when there isn't a usable one. Returns null — never a
 * partial or stale answer — for a different user, a different list scope, or an expired
 * stamp, so a caller cannot accidentally deal someone else's cards.
 */
export async function loadDeck(
  store: OfflineStore,
  params: { userId: string; listId: string | null; now?: number; slot?: DeckSlot },
): Promise<{ items: ReviewQueueItem[]; anchor: ClockAnchor } | null> {
  const cached = await store.get<CachedDeck>(KEYS[params.slot ?? "session"]);
  if (!cached) return null;
  if (cached.userId !== params.userId) return null;
  if ((cached.listId ?? null) !== (params.listId ?? null)) return null;
  if ((params.now ?? Date.now()) - cached.fetchedAt > DECK_TTL_MS) return null;
  return { items: cached.items, anchor: cached.anchor };
}

/** Drop the decks. On sign-out, and whenever a live queue supersedes them. */
export async function clearDeck(store: OfflineStore): Promise<void> {
  await Promise.all(Object.values(KEYS).map((key) => store.del(key)));
}
