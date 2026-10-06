// The pending-grade queue: reviews graded offline, waiting to reach the server.
//
// This is NOT a cache. The offline deck is a mirror and can be thrown away and refetched
// (see review.ts); a queued grade is the ONLY record that the user did that work. So the
// rules here are the opposite of a cache's: never drop an entry until the server has
// confirmed it, survive a cold start, and prefer replaying twice over losing one.
//
// Replaying twice is safe by construction — `record_review`'s
// UNIQUE (user_word_id, reviewed_on) collapses same-day reviews into one row and bumps
// `repeats` (migration 20260744), so a duplicate replay is a counter bump, not a second
// review. That is what lets this queue be at-least-once instead of exactly-once.
//
// PURE over an injected OfflineStore, so the whole thing is testable with no IndexedDB.

import type { OfflineStore } from "./store";
import type { ReviewGrade } from "../review";

const KEY = "pending-grades";

export interface PendingGrade {
  /** Client-generated, so a retry can be recognised in logs. */
  id: string;
  userWordId: string;
  grade: ReviewGrade;
  /** Which face of the card was up (true = meaning-first). Absent on grades queued by
   *  a build that didn't record it — replayed as "not recorded", never guessed. */
  reversed?: boolean;
  /** Server-anchored ISO instant — see clock.ts. */
  reviewedAt: string;
  /** True when no anchor was available and the local clock was used. */
  approx: boolean;
  /** Failed replay attempts; used to shelve a poison entry rather than block the queue. */
  attempts: number;
  /** Who graded it. A queue outlives a sign-out, and replaying A's grades under B's
   *  session is refused by the server and burns A's attempts — so each entry waits for
   *  ITS user. Absent on entries queued by an older build: those drain as before. */
  userId?: string;
}

/** After this many failed replays an entry stops blocking the others (see drainable). */
export const MAX_ATTEMPTS = 5;

// Who wants to know the queue changed: the replay scheduler (sync.ts — a new entry is
// the moment to start retrying) and the Review screen (its "N grades waiting" line
// reads the LIVE count, so a successful drain clears it).
const listeners = new Set<() => void>();
export function onQueueChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
function changed(): void {
  for (const fn of [...listeners]) fn();
}

/** Every queued grade, oldest first. Replay order matters: two grades of the SAME card
 *  must reach the server in the order they were given, or the later stability wins. */
export async function pending(store: OfflineStore): Promise<PendingGrade[]> {
  return (await store.get<PendingGrade[]>(KEY)) ?? [];
}

export async function enqueue(store: OfflineStore, entry: Omit<PendingGrade, "attempts">): Promise<void> {
  const q = await pending(store);
  q.push({ ...entry, attempts: 0 });
  await store.set(KEY, q);
  changed();
}

/**
 * Entries worth attempting now: everything under MAX_ATTEMPTS.
 *
 * A grade the server keeps rejecting (a word deleted on another device, say) must not
 * wedge the queue behind it — after MAX_ATTEMPTS it is skipped here but KEPT in storage,
 * so it can be inspected rather than vanishing.
 *
 * With `userId`, only that user's entries (and unstamped legacy ones): another user's
 * grades stay queued, untouched, until they sign back in on this device.
 */
export function drainable(q: PendingGrade[], userId?: string | null): PendingGrade[] {
  return q.filter(
    (e) => e.attempts < MAX_ATTEMPTS && (!e.userId || !userId || e.userId === userId),
  );
}

/** Drop the entries the server accepted. Called only after a confirmed write. */
export async function acknowledge(store: OfflineStore, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const done = new Set(ids);
  await store.set(KEY, (await pending(store)).filter((e) => !done.has(e.id)));
  changed();
}

/** Record a failed attempt, keeping the entry. */
export async function markFailed(store: OfflineStore, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const failed = new Set(ids);
  await store.set(
    KEY,
    (await pending(store)).map((e) => (failed.has(e.id) ? { ...e, attempts: e.attempts + 1 } : e)),
  );
  changed();
}

/** How many grades are waiting — the number the UI shows. */
export async function pendingCount(store: OfflineStore): Promise<number> {
  return (await pending(store)).length;
}

/** Clear everything. For sign-out: a queue belongs to the user who created it. */
export async function clearQueue(store: OfflineStore): Promise<void> {
  await store.del(KEY);
  changed();
}

/** Stable-ish id without pulling in a dependency; crypto.randomUUID where available. */
export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
