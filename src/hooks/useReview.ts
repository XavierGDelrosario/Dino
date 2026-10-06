// Drives one review session: loads the queue (N least-confident words) once,
// then walks it card by card — reveal, grade, advance — recording each grade
// through services/review. The queue is a SNAPSHOT taken at load; re-ranking
// happens on the next session (restart), not mid-session.
//
// Grading is OPTIMISTIC: the next card shows at once and the write runs in the
// background, so a slow round trip never sits between two cards. Writes for different
// cards overlap; the last grade moves the session to "saving" until every write has
// settled, so the done screen's dots are the real post-grade values. A write that fails
// is KEPT with its grade (`failed`) and re-sent by retryFailed — the user never has to
// re-grade. Same shape as useTextQuiz (a change to one flashcard quiz is a change to both).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getReviewQueue,
  recordReview,
  type ReviewGrade,
  type ReviewQueueItem,
} from "../services/review";
import { errorMessage as message } from "../lib/errorMessage";
import { useCardGap } from "./useCardGap";

export type ReviewStatus = "loading" | "reviewing" | "saving" | "empty" | "done" | "error";

/** A grade whose write failed, kept so it can be re-sent without re-grading. */
export interface FailedGrade {
  card: ReviewQueueItem;
  grade: ReviewGrade;
  /** The face that was up when it was graded — a retry re-sends the same fact. */
  reversed: boolean;
}

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
  const { advancing, after: afterGap, cancel: cancelGap } = useCardGap();
  const [status, setStatus] = useState<ReviewStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reviewedCount, setReviewedCount] = useState(0);
  /** Writes still in flight (any session). The "saving" status waits for this to hit 0. */
  const [saving, setSaving] = useState(0);
  const [failed, setFailed] = useState<FailedGrade[]>([]);
  /** Bumped per session, so a write that lands after a restart can't touch the new one. */
  const session = useRef(0);
  /** Each card's confidence after its grade (by userWordId) — the done screen's dots. */
  const [gradedConfidence, setGradedConfidence] = useState<ReadonlyMap<string, number>>(new Map());
  /** Grades taken offline and waiting to reach the server. Non-zero is the signal the
   *  UI needs to say "saved on this device" rather than implying the schedule updated. */
  const [pendingCount, setPendingCount] = useState(0);

  // Loads a session over an explicit id set. `ids === undefined` means "no
  // subset" — rank the whole list/vocabulary and take the weakest N (a fresh,
  // re-ranked queue). Passing a concrete id array quizzes EXACTLY those words
  // (used by "Retry quiz", which re-runs the set just reviewed regardless of
  // their new confidence).
  const runSession = useCallback(
    (ids: string[] | undefined) => {
      session.current += 1;
      cancelGap();
      setStatus("loading");
      setError(null);
      setFailed([]);
      setPendingCount(0); // per session: the done screen's offline note is about THIS one
      // A filtered subset = quiz all of it, capped at MAX_SUBSET_LIMIT (the weakest
      // that many, since the queue is ranked least-confident first); the general
      // queue (no subset) = the weakest DEFAULT_LIMIT. An explicit `limit` overrides.
      const effectiveLimit =
        limit ?? Math.min(ids?.length ?? DEFAULT_LIMIT, MAX_SUBSET_LIMIT);
      getReviewQueue({ userId, listId, limit: effectiveLimit, userWordIds: ids })
        .then((q) => {
          setQueue(shuffle(q));
          setIndex(0);
          setFlipped(false);
          setReviewedCount(0);
          setGradedConfidence(new Map());
          setStatus(q.length ? "reviewing" : "empty");
        })
        .catch((e) => {
          setError(message(e));
          setStatus("error");
        });
    },
    [userId, listId, limit, cancelGap]
  );

  // "New quiz" / initial load / error-retry: re-rank from scratch (the next
  // most-needed words). Honors the caller's subset prop when present.
  const newQuiz = useCallback(() => runSession(userWordIds), [runSession, userWordIds]);

  // "Retry quiz": re-run the EXACT words from the session just finished — the
  // completed `queue` still holds them at the "done"/end state.
  const retry = useCallback(
    () => runSession(queue.map((c) => c.userWordId)),
    [runSession, queue]
  );

  useEffect(() => {
    newQuiz();
  }, [newQuiz]);

  const flip = useCallback(() => setFlipped(true), []);

  /** Record one grade in the background. Resolves either way; never throws. */
  const write = useCallback((card: ReviewQueueItem, g: ReviewGrade, reversed: boolean) => {
    const token = session.current;
    setSaving((n) => n + 1);
    // The only call that hits record_review(). With no network the grade is QUEUED and
    // this resolves with `queued: true` rather than throwing (services/review.ts,
    // isUnreachable); a real refusal throws and the grade is kept in `failed`.
    return recordReview({
      userWordId: card.userWordId,
      grade: g,
      reversed,
      current: {
        stability: card.stability,
        confidenceRating: card.confidenceRating,
        lastReviewedDate: card.lastReviewedDate,
      },
    })
      .then(
        (res) => {
          if (session.current !== token) return;
          if (res.queued) setPendingCount((n) => n + 1);
          setGradedConfidence((m) => new Map(m).set(card.userWordId, res.confidenceRating));
        },
        (e) => {
          if (session.current !== token) return;
          setFailed((f) => [...f, { card, grade: g, reversed }]);
          setError(message(e));
        },
      )
      .finally(() => setSaving((n) => n - 1));
  }, []);

  // `reversed` = the card was showing its MEANING first (the view's quiz flip). It is
  // logged with the grade and changes nothing about the schedule.
  const grade = useCallback(
    (g: ReviewGrade, reversed = false) => {
      const card = queue[index];
      if (!card || status !== "reviewing" || advancing) return;
      void write(card, g, reversed);
      setReviewedCount((n) => n + 1);
      const next = index + 1;
      if (next >= queue.length) {
        setStatus("saving");
      } else {
        afterGap(() => {
          setIndex(next);
          setFlipped(false);
        });
      }
    },
    [queue, index, status, advancing, afterGap, write]
  );

  // The last grade waits here until every write has landed, then shows the recap.
  useEffect(() => {
    if (status === "saving" && saving === 0) setStatus("done");
  }, [status, saving]);

  /** Re-send the grades whose writes failed (the done screen's retry). */
  const retryFailed = useCallback(() => {
    const toSend = failed;
    if (toSend.length === 0) return;
    setFailed([]);
    setError(null);
    setStatus("saving");
    for (const f of toSend) void write(f.card, f.grade, f.reversed);
  }, [failed, write]);

  return {
    status,
    current: status === "reviewing" ? queue[index] ?? null : null,
    flipped,
    flip,
    grade,
    /** The pause between cards: hide the graded card. */
    advancing,
    /** No grading right now — between cards, or saving the finished session. */
    locked: advancing || status === "saving",
    /** True only while the finished session waits for its last writes. */
    submitting: status === "saving",
    error,
    /** Grades whose writes failed; re-send with retryFailed. */
    failed,
    retryFailed,
    position: index + 1,
    total: queue.length,
    /** The session's cards — at "done", the words just quizzed (the recap list). */
    cards: queue,
    /** Confidence after this session's grade, by userWordId (absent = not graded). */
    gradedConfidence,
    reviewedCount,
    /** Of `reviewedCount`, how many are queued offline rather than recorded. */
    pendingCount,
    /** Fresh, re-ranked session (next most-needed words). Also the error-retry. */
    newQuiz,
    /** Re-run the exact words from the session just finished. */
    retry,
    /** @deprecated alias of newQuiz, kept for the error state's retry button. */
    restart: newQuiz,
  };
}
