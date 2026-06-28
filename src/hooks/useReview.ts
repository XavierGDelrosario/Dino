// Drives one review session: loads the queue (N least-confident words) once,
// then walks it card by card — reveal, grade, advance — recording each grade
// through services/review. The queue is a SNAPSHOT taken at load; re-ranking
// happens on the next session (restart), not mid-session.
import { useCallback, useEffect, useState } from "react";
import {
  getReviewQueue,
  recordReview,
  type ReviewGrade,
  type ReviewQueueItem,
} from "../services/review";
import { errorMessage as message } from "../lib/errorMessage";

export type ReviewStatus = "loading" | "reviewing" | "empty" | "done" | "error";

const DEFAULT_LIMIT = 20;
/** Ceiling for the filtered-subset path so a huge sub-list can't spawn an
 *  unbounded flashcard session (the general queue is already capped at
 *  DEFAULT_LIMIT). */
const MAX_SUBSET_LIMIT = 100;

/** Fisher–Yates shuffle (copy) — quiz order is randomized so the same weakest
 *  words don't always appear in the same sequence. getReviewQueue still SELECTS
 *  the least-confident set; this only randomizes their presentation order. */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function useReview(
  userId: string,
  listId: string | null = null,
  limit?: number,
  /** When set, quiz EXACTLY these words — all of them up to MAX_SUBSET_LIMIT (the
   *  Lists view's filtered subset, which may exceed DEFAULT_LIMIT), not just the
   *  weakest N. */
  userWordIds?: string[]
) {
  const [queue, setQueue] = useState<ReviewQueueItem[]>([]);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [status, setStatus] = useState<ReviewStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reviewedCount, setReviewedCount] = useState(0);

  const load = useCallback(() => {
    setStatus("loading");
    setError(null);
    // A filtered subset = quiz all of it, capped at MAX_SUBSET_LIMIT (the weakest
    // that many, since the queue is ranked least-confident first); the general
    // queue (no subset) = the weakest DEFAULT_LIMIT. An explicit `limit` overrides.
    const effectiveLimit =
      limit ?? Math.min(userWordIds?.length ?? DEFAULT_LIMIT, MAX_SUBSET_LIMIT);
    getReviewQueue({ userId, listId, limit: effectiveLimit, userWordIds })
      .then((q) => {
        setQueue(shuffle(q));
        setIndex(0);
        setFlipped(false);
        setReviewedCount(0);
        setStatus(q.length ? "reviewing" : "empty");
      })
      .catch((e) => {
        setError(message(e));
        setStatus("error");
      });
  }, [userId, listId, limit, userWordIds]);

  useEffect(() => {
    load();
  }, [load]);

  const flip = useCallback(() => setFlipped(true), []);

  const grade = useCallback(
    async (g: ReviewGrade) => {
      const card = queue[index];
      if (!card || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        // The only call that hits record_review() — the as-yet-unverified RPC.
        // On failure we KEEP the card so the user can retry the same grade.
        await recordReview({ userWordId: card.userWordId, grade: g });
        setReviewedCount((n) => n + 1);
        const next = index + 1;
        if (next >= queue.length) {
          setStatus("done");
        } else {
          setIndex(next);
          setFlipped(false);
        }
      } catch (e) {
        setError(message(e));
      } finally {
        setSubmitting(false);
      }
    },
    [queue, index, submitting]
  );

  return {
    status,
    current: status === "reviewing" ? queue[index] ?? null : null,
    flipped,
    flip,
    grade,
    submitting,
    error,
    position: index + 1,
    total: queue.length,
    reviewedCount,
    restart: load,
  };
}
