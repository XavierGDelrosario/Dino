// Drain the pending-grade queue back to the server.
//
// Replay is AT-LEAST-ONCE, deliberately: `record_review`'s
// UNIQUE (user_word_id, reviewed_on) collapses same-day reviews and bumps `repeats`
// (20260744), so sending one twice is a counter bump rather than a second review. Given
// that, losing a grade is the only real failure mode, so an entry is dropped strictly
// after the server confirms it.
//
// Order matters within a card: two grades of the same word must arrive in the order they
// were given, or the earlier one's stability lands last and wins. So the fan-out below
// is capped AND grouped — different cards run concurrently, one card runs in sequence.

import { mapLimit } from "../../lib/concurrency";
import { sendReview } from "../review";
import { offlineStore } from "./store";
import { acknowledge, drainable, markFailed, pending, type PendingGrade } from "./queue";

/** Concurrency for the replay fan-out. Matches MAX_TRANSLATION_CONCURRENCY's reasoning:
 *  enough to drain a session quickly, not enough to look like a burst. */
const REPLAY_CONCURRENCY = 4;

export interface DrainResult {
  sent: number;
  failed: number;
  /** Still queued afterwards (failures, plus anything shelved past MAX_ATTEMPTS). */
  remaining: number;
}

let inflight: Promise<DrainResult> | null = null;

/**
 * Send everything queued. Concurrent calls SHARE one drain — the reconnect listener and
 * a manual retry can both fire, and two drains would replay the same entries twice.
 * (Harmless per the compaction above, but pointless traffic.)
 */
export function drainPendingReviews(): Promise<DrainResult> {
  return (inflight ??= runDrain().finally(() => {
    inflight = null;
  }));
}

async function runDrain(): Promise<DrainResult> {
  const store = offlineStore();
  const queued = drainable(await pending(store));
  if (queued.length === 0) return { sent: 0, failed: 0, remaining: (await pending(store)).length };

  // Group by card so one card's grades stay ordered; different cards go in parallel.
  const byCard = new Map<string, PendingGrade[]>();
  for (const e of queued) {
    const list = byCard.get(e.userWordId);
    if (list) list.push(e);
    else byCard.set(e.userWordId, [e]);
  }

  const ok: string[] = [];
  const bad: string[] = [];

  await mapLimit([...byCard.values()], REPLAY_CONCURRENCY, async (entries) => {
    for (const e of entries) {
      try {
        await sendReview({ userWordId: e.userWordId, grade: e.grade, reviewedAt: e.reviewedAt });
        ok.push(e.id);
      } catch {
        // Stop this CARD at its first failure so a later grade can't overtake an
        // earlier one. Other cards keep draining.
        bad.push(e.id);
        break;
      }
    }
  });

  await acknowledge(store, ok);
  await markFailed(store, bad);
  return { sent: ok.length, failed: bad.length, remaining: (await pending(store)).length };
}

/**
 * Drain whenever the browser reports a reconnect, and once on startup.
 *
 * `navigator.onLine` is only trusted in the NEGATIVE — "online" routinely lies about a
 * captive portal or a dead uplink, which is why the drain simply attempts and treats a
 * throw as still-offline rather than pre-checking. Returns a teardown.
 */
export function watchForReconnect(): () => void {
  const attempt = () => void drainPendingReviews().catch(() => {});
  attempt(); // a queue can survive a cold start; don't wait for an online event
  if (typeof window === "undefined") return () => {};
  window.addEventListener("online", attempt);
  return () => window.removeEventListener("online", attempt);
}
