// Drives an "extract-and-quiz" session over the NEW content words in a pasted text
// (useTranslate's addableCards). Each CARD is one word's full sense list, primary
// first, and the user can cycle meanings with ←/→ and add a chosen one.
//
// Unlike useReview, which quizzes ALREADY-saved words, each grade here both ADDS the
// selected sense and records the first review — so studying media feeds spaced
// repetition seeded by how you scored it. The ＋ button adds without grading.
//
// Grading is OPTIMISTIC, exactly as in useReview: the next card shows at once and the
// save + review run in the background (in order per card, overlapping across cards).
// The last grade moves the session to "saving" until every write has settled, so the
// recap carries real saved rows and confidences; a failed write keeps its grade in
// `failed` for retryFailed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { saveDictionaryWord } from "../services/words/userWords";
import { recordReview, type ReviewGrade } from "../services/review";
import { estimateLevel, setUserLevel, type CalibrationSample } from "../services/calibration";
import { getDifficulty } from "../services/difficulty";
import { errorMessage as message } from "../lib/errorMessage";
import type { Word } from "../services/words/repository";

export type TextQuizStatus = "reviewing" | "saving" | "empty" | "done" | "error";

/** Called after a sense is saved + graded (or added), so the caller (the reader)
 *  can sync its own saved/confidence state without re-translating. */
export type OnGraded = (
  wordId: string,
  userWordId: string,
  confidenceRating: number,
) => void;

/** A grade whose write failed, kept (with its card position) to be re-sent. */
export interface FailedTextGrade {
  index: number;
  word: Word;
  grade: ReviewGrade;
}

/** One card of a finished session: the sense graded, its saved row, its confidence. */
export interface GradedWord {
  word: Word;
  userWordId: string;
  confidence: number;
  /** What it read BEFORE this grade — the recap marks the dots between the two. */
  previousConfidence: number;
}

export function useTextQuiz(
  userId: string,
  cards: Word[][],
  opts: { onGraded?: OnGraded; calibrate?: boolean } = {},
) {
  const { onGraded, calibrate = false } = opts;
  const [index, setIndex] = useState(0);
  // Which sense of the current word is shown (0 = primary). Reset per card.
  const [meaningIndex, setMeaningIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [status, setStatus] = useState<TextQuizStatus>(
    cards.length ? "reviewing" : "empty",
  );
  const [error, setError] = useState<string | null>(null);
  const [reviewedCount, setReviewedCount] = useState(0);
  /** Writes still in flight (any session). The "saving" status waits for this to hit 0. */
  const [saving, setSaving] = useState(0);
  const [failed, setFailed] = useState<FailedTextGrade[]>([]);
  /** Bumped per session, so a write that lands after a restart can't touch the new one. */
  const session = useRef(0);
  /** The level is persisted once per finished session. */
  const calibrated = useRef(false);
  // wordIds already added to the vocabulary this session (via ＋ or a grade), so
  // the add button can show its ✓ state.
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  // The sense graded on each card, keyed by card position — the done screen's recap. The
  // GRADED sense, not the primary: cycling to another meaning and grading it is what was
  // studied. Carries the saved row + its post-grade confidence, so the recap's dots are
  // live. Keyed (not appended) because background writes can land out of order.
  const [results, setResults] = useState<ReadonlyMap<number, GradedWord>>(new Map());
  const graded = useMemo(
    () => [...results.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w),
    [results],
  );

  // Level calibration is a SILENT byproduct of the quiz — no UI. Each first-encounter
  // grade is a (difficulty, grade) sample; on finish the level is estimated and
  // persisted. A ref, so it survives re-renders.
  const samples = useRef<CalibrationSample[]>([]);

  // The word set is a SNAPSHOT taken when the session opens; restart re-walks it.
  const restart = useCallback(() => {
    session.current += 1;
    calibrated.current = false;
    setFailed([]);
    setIndex(0);
    setMeaningIndex(0);
    setFlipped(false);
    setReviewedCount(0);
    setResults(new Map());
    setError(null);
    setSavedIds(new Set());
    samples.current = [];
    setStatus(cards.length ? "reviewing" : "empty");
  }, [cards.length]);

  // Re-arm if the caller opens the quiz with a different set.
  useEffect(() => {
    restart();
  }, [restart]);

  const flip = useCallback(() => setFlipped(true), []);

  const senses = status === "reviewing" ? cards[index] ?? [] : [];
  // Clamp so a stale meaningIndex can't point past a shorter card.
  const sense: Word | null = senses[meaningIndex] ?? senses[0] ?? null;

  const cycleMeaning = useCallback(
    (delta: number) =>
      setMeaningIndex((i) => {
        const n = cards[index]?.length ?? 0;
        return n ? (i + delta + n) % n : 0;
      }),
    [cards, index],
  );
  const nextMeaning = useCallback(() => cycleMeaning(1), [cycleMeaning]);
  const prevMeaning = useCallback(() => cycleMeaning(-1), [cycleMeaning]);

  const markSaved = useCallback((wordId: string) => {
    setSavedIds((s) => (s.has(wordId) ? s : new Set(s).add(wordId)));
  }, []);

  /** ＋ button: add a sense to the vocabulary (no review), optionally tagging it
   *  into a sub-list. Idempotent; stays on the card so the user can still
   *  grade/cycle. Takes the word explicitly so the add-to-list menu tags the sense
   *  that was showing when it opened, even if the meaning is cycled meanwhile. */
  const addWord = useCallback(
    async (word: Word, listId?: string) => {
      const uw = await saveDictionaryWord({ userId, word, listId });
      markSaved(word.wordId);
      onGraded?.(word.wordId, uw.userWordId, uw.confidenceRating);
    },
    [userId, markSaved, onGraded],
  );

  /** Save + record one grade in the background. Resolves either way; never throws. */
  const write = useCallback(
    (at: number, word: Word, g: ReviewGrade) => {
      const token = session.current;
      setSaving((n) => n + 1);
      // Add the selected sense, then record the first review with the grade (the review
      // needs the saved row's id, so these two stay in order). saveDictionaryWord is
      // idempotent, so a retry — or re-grading a word — is safe.
      return (async () => {
        const uw = await saveDictionaryWord({ userId, word });
        const res = await recordReview({ userWordId: uw.userWordId, grade: g });
        return { uw, res };
      })()
        .then(
          ({ uw, res }) => {
            // The word IS saved and reviewed even if the session moved on, so the reader
            // behind the quiz is told either way; only this session's state is guarded.
            onGraded?.(word.wordId, uw.userWordId, res.confidenceRating);
            if (session.current !== token) return;
            markSaved(word.wordId);
            setResults((m) =>
              new Map(m).set(at, {
                word,
                userWordId: uw.userWordId,
                confidence: res.confidenceRating,
                // saveDictionaryWord runs BEFORE recordReview and its ON CONFLICT touches
                // only `input`, so this row is the word as it stood going in — the live
                // display value (toUserWord runs rowConfidence), not the stored snapshot.
                // A word new to the vocabulary reports its cold-start seed, which is the
                // honest baseline: the quiz is what moved it off that.
                previousConfidence: uw.confidenceRating,
              }),
            );
          },
          (e) => {
            if (session.current !== token) return;
            setFailed((f) => [...f, { index: at, word, grade: g }]);
            setError(message(e));
          },
        )
        .finally(() => setSaving((n) => n - 1));
    },
    [userId, markSaved, onGraded],
  );

  const grade = useCallback(
    (g: ReviewGrade) => {
      const word = sense;
      if (!word || status !== "reviewing") return;
      void write(index, word, g);
      if (calibrate) {
        const difficulty = getDifficulty(word).level;
        if (difficulty != null) samples.current.push({ difficulty, grade: g });
      }
      setReviewedCount((n) => n + 1);
      const next = index + 1;
      if (next >= cards.length) {
        setStatus("saving");
      } else {
        setIndex(next);
        setMeaningIndex(0);
        setFlipped(false);
      }
    },
    [sense, status, write, calibrate, index, cards.length],
  );

  // The last grade waits here until every write has landed, then shows the recap —
  // and, for a calibrating session, estimates + persists the level once (silently; a
  // small/easy quiz can't wipe a better one, and a failure just skips this round).
  useEffect(() => {
    if (status !== "saving" || saving !== 0) return;
    setStatus("done");
    if (calibrate && !calibrated.current) {
      calibrated.current = true;
      const level = estimateLevel(samples.current);
      if (level != null) {
        void setUserLevel(userId, level).catch((e) =>
          console.warn("calibration: failed to persist level", e),
        );
      }
    }
  }, [status, saving, calibrate, userId]);

  /** Re-send the grades whose writes failed (the done screen's retry). */
  const retryFailed = useCallback(() => {
    const toSend = failed;
    if (toSend.length === 0) return;
    setFailed([]);
    setError(null);
    setStatus("saving");
    for (const f of toSend) void write(f.index, f.word, f.grade);
  }, [failed, write]);

  return {
    status,
    // the selected sense (the card face) + the full sense list for cycling
    current: sense,
    senses,
    meaningIndex,
    hasMultipleMeanings: senses.length > 1,
    nextMeaning,
    prevMeaning,
    // ＋ add-to-list
    addWord,
    isCurrentSaved: sense ? savedIds.has(sense.wordId) : false,
    // flashcard loop
    flipped,
    flip,
    grade,
    /** True only while the finished session waits for its last writes. */
    submitting: status === "saving",
    error,
    /** Grades whose writes failed; re-send with retryFailed. */
    failed,
    retryFailed,
    position: index + 1,
    total: cards.length,
    reviewedCount,
    /** The sense graded on each card, in session order (the done screen's recap). */
    graded,
    restart,
  };
}
