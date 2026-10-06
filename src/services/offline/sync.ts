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
import { isUnreachableError, sendReview } from "../review";
import { supabase } from "../../config/supabaseClient";
import { offlineStore } from "./store";
import { acknowledge, drainable, markFailed, onQueueChanged, pending, type PendingGrade } from "./queue";
import { Capacitor } from "@capacitor/core";

/** Concurrency for the replay fan-out. Matches MAX_TRANSLATION_CONCURRENCY's reasoning:
 *  enough to drain a session quickly, not enough to look like a burst. */
const REPLAY_CONCURRENCY = 4;

export interface DrainResult {
  sent: number;
  failed: number;
  /** Still queued afterwards (failures, anything unsent because the server could not be
   *  reached, plus anything shelved past MAX_ATTEMPTS). */
  remaining: number;
  /** The drain stopped because a send got NO answer — worth retrying soon. */
  unreachable: boolean;
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
  // getSession reads local storage — no network — so this works on the reconnect edge.
  const userId = (await supabase.auth.getSession()).data.session?.user.id ?? null;
  const queued = drainable(await pending(store), userId);
  if (queued.length === 0) return { sent: 0, failed: 0, remaining: (await pending(store)).length, unreachable: false };

  // Group by card so one card's grades stay ordered; different cards go in parallel.
  const byCard = new Map<string, PendingGrade[]>();
  for (const e of queued) {
    const list = byCard.get(e.userWordId);
    if (list) list.push(e);
    else byCard.set(e.userWordId, [e]);
  }

  const ok: string[] = [];
  const bad: string[] = [];

  // Set the moment a send gets NO answer. That is not a failed attempt, it is "still
  // offline" — a captive portal or a dead uplink fires `online` all the same — and
  // counting it would walk a perfectly good grade to MAX_ATTEMPTS and shelve it for
  // good. So nothing is marked, and the cards not yet started don't try at all.
  let unreachable = false;

  await mapLimit([...byCard.values()], REPLAY_CONCURRENCY, async (entries) => {
    for (const e of entries) {
      if (unreachable) return;
      try {
        await sendReview({
          userWordId: e.userWordId,
          grade: e.grade,
          reviewedAt: e.reviewedAt,
          reversed: e.reversed,
        });
        ok.push(e.id);
      } catch (err) {
        // Stop this CARD at its first failure so a later grade can't overtake an
        // earlier one. Other cards keep draining — unless the server is simply gone.
        if (isUnreachableError(err)) unreachable = true;
        else bad.push(e.id);
        break;
      }
    }
  });

  await acknowledge(store, ok);
  await markFailed(store, bad);
  return { sent: ok.length, failed: bad.length, remaining: (await pending(store)).length, unreachable };
}

/** Retry gaps after a drain that could not reach the server, while the app is open. A
 *  grade is queued on ONE failed fetch (isUnreachable), and on a phone that is usually a
 *  blip — a tunnel, a tower hand-off, the app backgrounded mid-request — not a day
 *  offline, so the first retries are quick and only then back off. */
const RETRY_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

/**
 * Drain whenever the device reconnects or the app comes back, once on startup, as soon
 * as a grade is queued, and on a backoff while anything is still waiting.
 *
 * `navigator.onLine` / the `online` event are only trusted in the NEGATIVE — "online"
 * routinely lies about a captive portal or a dead uplink, which is why every trigger
 * simply attempts and treats a throw as still-offline rather than pre-checking. In the
 * iOS app the `online` event is not a reliable signal at all (a WKWebView on cellular
 * never sees a transition), so the Capacitor Network and App plugins add theirs.
 * Returns a teardown.
 */
export function watchForReconnect(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let step = 0;
  let stopped = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const attempt = () => {
    if (stopped) return;
    clear();
    void drainPendingReviews()
      .then((r) => {
        if (stopped) return;
        if (r.remaining > 0 && r.unreachable) {
          timer = setTimeout(attempt, RETRY_MS[Math.min(step, RETRY_MS.length - 1)]);
          step++;
        } else {
          step = 0;
        }
      })
      .catch(() => {});
  };
  // A fresh entry means the user just graded something with no answer from the server:
  // start (or restart) the quick retries. Drains also change the queue, so only react
  // when nothing is already scheduled.
  const offQueue = onQueueChanged(() => {
    if (!timer && !inflight) {
      step = 0;
      timer = setTimeout(attempt, RETRY_MS[0]);
    }
  });
  attempt(); // a queue can survive a cold start; don't wait for an online event

  const teardowns: Array<() => void> = [offQueue, clear];
  if (typeof window !== "undefined") {
    window.addEventListener("online", attempt);
    teardowns.push(() => window.removeEventListener("online", attempt));
    const onVisible = () => {
      if (document.visibilityState === "visible") attempt();
    };
    document.addEventListener("visibilitychange", onVisible);
    teardowns.push(() => document.removeEventListener("visibilitychange", onVisible));
  }
  if (Capacitor.isNativePlatform()) {
    // Loaded lazily so the web bundle and the unit tests never touch the native plugins.
    void import("@capacitor/network").then(({ Network }) => {
      if (stopped) return;
      const h = Network.addListener("networkStatusChange", (st) => {
        if (st.connected) attempt();
      });
      teardowns.push(() => void h.then((x) => x.remove()).catch(() => {}));
    }).catch(() => {});
    void import("@capacitor/app").then(({ App }) => {
      if (stopped) return;
      const h = App.addListener("appStateChange", (st) => {
        if (st.isActive) attempt();
      });
      teardowns.push(() => void h.then((x) => x.remove()).catch(() => {}));
    }).catch(() => {});
  }
  return () => {
    stopped = true;
    for (const fn of teardowns) fn();
  };
}

