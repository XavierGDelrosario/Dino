// The study days behind the 🔥 badge and /goals, as ONE shared store: the badge is on
// every page and the goals page needs the same rows, so a module-level cache keyed on
// the user serves both from one RPC. Refreshed when the vocabulary cache records a
// WRITE (a save or a grade — services/words/vocabularyCache is written through by
// every service that changes user_words), and when the tab comes back into view, so a
// grade given on another device shows up on return.
//
// `days` is undefined while loading and NULL when this database has no study_days()
// yet (pre-20260790) — the badge hides rather than erroring.
import { useEffect, useSyncExternalStore } from "react";
import { computeStreaks, getStudyDays, todayProgress, type StudyDay } from "../services/streak";
import { onStudyActivity } from "../services/studyActivity";
import { dayKey } from "../services/words/filters";

interface Store {
  userId: string | null;
  days: StudyDay[] | null | undefined;
  loadedAt: number;
}

let store: Store = { userId: null, days: undefined, loadedAt: 0 };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

const notify = () => {
  for (const fn of listeners) fn();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const snapshot = () => store;

/** How long a loaded answer is trusted before a focus/visibility event re-asks. */
const STALE_MS = 60_000;
/** Writes arrive in bursts (Add all, a quiz) — one refetch per burst. */
const DEBOUNCE_MS = 800;

/** Re-read the user's days. Coalesces concurrent callers onto one request. */
export function refreshStreak(userId: string): Promise<void> {
  if (inflight && store.userId === userId) return inflight;
  if (store.userId !== userId) store = { userId, days: undefined, loadedAt: 0 };
  const p: Promise<void> = getStudyDays()
    .then((days) => {
      if (store.userId !== userId) return;
      store = { userId, days, loadedAt: Date.now() };
      notify();
    })
    .catch(() => {
      // A failed read (network, 5xx) keeps whatever was shown. It must NOT become
      // null — null means "no study_days() on this database" and would hide the badge
      // for the whole session. Stamp loadedAt so the next focus can retry.
      if (store.userId === userId) store = { ...store, loadedAt: Date.now() };
    })
    .finally(() => {
      // Only clear OUR slot: a user switch may already have a newer request in flight.
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

/** Tests only. */
export function resetStreakStore(): void {
  store = { userId: null, days: undefined, loadedAt: 0 };
  inflight = null;
}

export function useStreak(userId: string) {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (!userId) return; // no session yet (App renders before the guest exists)
    if (store.userId !== userId || store.days === undefined) void refreshStreak(userId);

    // A save or a grade changes today's numbers: refetch once the burst settles.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = onStudyActivity(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refreshStreak(userId), DEBOUNCE_MS);
    });

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - store.loadedAt > STALE_MS) void refreshStreak(userId);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId]);

  const days = s.userId === userId ? s.days : undefined;
  const today = dayKey(new Date());
  return {
    /** undefined = loading · null = this database can't answer · else the rows. */
    days,
    streaks: days ? computeStreaks(days, today) : null,
    today: days ? todayProgress(days, today) : null,
    refresh: () => refreshStreak(userId),
  };
}
