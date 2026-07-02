// Drives an "extract-and-quiz" session over the NEW content words found in a
// pasted text (the words not yet in the user's vocabulary — see useTranslate's
// addableCards). Each CARD is one word's full sense list (primary first); the
// user can cycle its meanings with ←/→ and add a chosen one. Unlike useReview
// (which quizzes ALREADY-saved words), each grade here both ADDS the selected
// sense to the vocabulary and records the first review, so studying a piece of
// media feeds spaced repetition seeded by how you scored it. A ＋ button adds the
// currently-selected sense (default: the first) without grading.
import { useCallback, useEffect, useRef, useState } from "react";
import { saveDictionaryWord } from "../services/words/userWords";
import { recordReview, type ReviewGrade } from "../services/review";
import { estimateLevel, setUserLevel, type CalibrationSample } from "../services/calibration";
import { getDifficulty } from "../services/difficulty";
import { errorMessage as message } from "../lib/errorMessage";
import type { Word } from "../services/words/repository";

export type TextQuizStatus = "reviewing" | "empty" | "done" | "error";

/** Called after a sense is saved + graded (or added), so the caller (the reader)
 *  can sync its own saved/confidence state without re-translating. */
export type OnGraded = (
  wordId: string,
  userWordId: string,
  confidenceRating: number,
) => void;

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
  const [submitting, setSubmitting] = useState(false);
  const [reviewedCount, setReviewedCount] = useState(0);
  // wordIds already added to the vocabulary this session (via ＋ or a grade), so
  // the add button can show its ✓ state.
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  // Level calibration (#10) is a SILENT byproduct of the learn quiz — no UI. Each
  // first-encounter grade is a (difficulty, grade) sample; on finish we estimate
  // the user's level and persist it. Accumulated in a ref so it survives re-renders.
  const samples = useRef<CalibrationSample[]>([]);

  // The word set is a SNAPSHOT taken when the session opens; restart re-walks it.
  const restart = useCallback(() => {
    setIndex(0);
    setMeaningIndex(0);
    setFlipped(false);
    setReviewedCount(0);
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

  /** ＋ button: add the currently-selected sense to the vocabulary (no review).
   *  Idempotent; stays on the card so the user can still grade/cycle. */
  const addCurrent = useCallback(async () => {
    if (!sense || submitting || savedIds.has(sense.wordId)) return;
    setSubmitting(true);
    setError(null);
    try {
      const uw = await saveDictionaryWord({ userId, word: sense });
      markSaved(sense.wordId);
      onGraded?.(sense.wordId, uw.userWordId, uw.confidenceRating);
    } catch (e) {
      setError(message(e));
    } finally {
      setSubmitting(false);
    }
  }, [sense, submitting, savedIds, userId, markSaved, onGraded]);

  const grade = useCallback(
    async (g: ReviewGrade) => {
      const word = sense;
      if (!word || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        // Add the selected sense, then record the first review with the grade.
        // saveDictionaryWord is idempotent, so re-grading a word is safe.
        const uw = await saveDictionaryWord({ userId, word });
        const res = await recordReview({ userWordId: uw.userWordId, grade: g });
        markSaved(word.wordId);
        onGraded?.(word.wordId, uw.userWordId, res.confidenceRating);
        if (calibrate) {
          const difficulty = getDifficulty(word).level;
          if (difficulty != null) samples.current.push({ difficulty, grade: g });
        }
        setReviewedCount((n) => n + 1);
        const next = index + 1;
        if (next >= cards.length) {
          setStatus("done");
          // Estimate + persist the level silently (a small/easy quiz can't wipe a
          // better one); fire-and-forget, a failure just skips this round.
          if (calibrate) {
            const level = estimateLevel(samples.current);
            if (level != null) {
              void setUserLevel(userId, level).catch((e) =>
                console.warn("calibration: failed to persist level", e),
              );
            }
          }
        } else {
          setIndex(next);
          setMeaningIndex(0);
          setFlipped(false);
        }
      } catch (e) {
        // Keep the card on failure so the user can retry the same grade.
        setError(message(e));
      } finally {
        setSubmitting(false);
      }
    },
    [sense, submitting, userId, markSaved, onGraded, calibrate, index, cards.length],
  );

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
    addCurrent,
    isCurrentSaved: sense ? savedIds.has(sense.wordId) : false,
    // flashcard loop
    flipped,
    flip,
    grade,
    submitting,
    error,
    position: index + 1,
    total: cards.length,
    reviewedCount,
    restart,
  };
}
