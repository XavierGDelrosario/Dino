// "Something was studied just now" — a one-line signal from the services that write a
// save or a grade (userWords.ts, review.ts) to whatever shows today's numbers (the 🔥
// badge and /goals through hooks/useStreak). A LEAF module with no imports, so either
// side can depend on it without a cycle.
//
// It exists because the vocabulary cache is NOT a reliable write signal: its
// write-through only records a write when the Lists store already exists, so a save
// from Translate or a grade in Review on a session that never opened Lists leaves it
// silent. Every write path calls this instead, including the offline replay (it goes
// through sendReview).
const listeners = new Set<() => void>();

/** Subscribe to study writes. Returns the unsubscribe. */
export function onStudyActivity(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Called by the write services after a save or a grade has landed on the server. */
export function notifyStudyActivity(): void {
  for (const fn of [...listeners]) fn();
}
