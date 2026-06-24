// Drives an "extract-and-quiz" session over the NEW content words found in a
// pasted text (the words not yet in the user's vocabulary — see useTranslate's
// addablePrimaries). Unlike useReview (which quizzes ALREADY-saved words), each
// grade here both ADDS the word to the vocabulary and records the first review,
// so studying a piece of media feeds spaced repetition seeded by how you scored
// it. Reuses the dictionary Word straight from the paragraph lookup as the card.
import { useCallback, useEffect, useRef, useState } from "react";
import { saveDictionaryWord } from "../services/words/userWords";
import { recordReview, type ReviewGrade } from "../services/review";
import { estimateLevel, setUserLevel, type CalibrationSample } from "../services/calibration";
import { getDifficulty } from "../services/difficulty";
import { errorMessage as message } from "../lib/errorMessage";
import type { Word } from "../services/words/repository";

export type TextQuizStatus = "reviewing" | "empty" | "done" | "error";

/** Called after a word is saved + graded, so the caller (the reader) can sync its
 *  own saved/confidence state without re-translating. */
export type OnGraded = (
  wordId: string,
  userWordId: string,
  confidenceRating: number,
) => void;

export function useTextQuiz(
  userId: string,
  words: Word[],
  opts: { onGraded?: OnGraded; calibrate?: boolean } = {},
) {
  const { onGraded, calibrate = false } = opts;
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [status, setStatus] = useState<TextQuizStatus>(
    words.length ? "reviewing" : "empty",
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reviewedCount, setReviewedCount] = useState(0);

  // Level calibration (#10) is a SILENT byproduct of the learn quiz — no UI. Each
  // first-encounter grade is a (difficulty, grade) sample; on finish we estimate
  // the user's level and persist it (later used to seed cold-start stability for
  // un-quizzed adds). Accumulated in a ref so it survives re-renders mid-session.
  const samples = useRef<CalibrationSample[]>([]);

  // The word set is a SNAPSHOT taken when the session opens (the caller mounts the
  // quiz with a fixed list); restart re-walks the same snapshot.
  const restart = useCallback(() => {
    setIndex(0);
    setFlipped(false);
    setReviewedCount(0);
    setError(null);
    samples.current = [];
    setStatus(words.length ? "reviewing" : "empty");
  }, [words.length]);

  // Re-arm if the caller opens the quiz with a different set.
  useEffect(() => {
    restart();
  }, [restart]);

  const flip = useCallback(() => setFlipped(true), []);

  const grade = useCallback(
    async (g: ReviewGrade) => {
      const word = words[index];
      if (!word || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        // Add the new word, then record the first review with the self-rated grade.
        // saveDictionaryWord is idempotent, so re-grading a word is safe.
        const uw = await saveDictionaryWord({ userId, word });
        const res = await recordReview({ userWordId: uw.userWordId, grade: g });
        onGraded?.(word.wordId, uw.userWordId, res.confidenceRating);
        if (calibrate) {
          const difficulty = getDifficulty(word).level;
          if (difficulty != null) samples.current.push({ difficulty, grade: g });
        }
        setReviewedCount((n) => n + 1);
        const next = index + 1;
        if (next >= words.length) {
          setStatus("done");
          // Estimate + persist the level silently. Only a non-null estimate is
          // written (a small/easy quiz can't wipe a better one); fire-and-forget,
          // a failure just skips this round's update.
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
          setFlipped(false);
        }
      } catch (e) {
        // Keep the card on failure so the user can retry the same grade.
        setError(message(e));
      } finally {
        setSubmitting(false);
      }
    },
    [words, index, submitting, userId, onGraded, calibrate],
  );

  return {
    status,
    current: status === "reviewing" ? words[index] ?? null : null,
    flipped,
    flip,
    grade,
    submitting,
    error,
    position: index + 1,
    total: words.length,
    reviewedCount,
    restart,
  };
}
