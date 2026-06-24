// Quiz session over the words in a pasted text, reveal → rate → next. Two modes:
//   · learn  — the NEW words; each rating ADDS the word + records a first review.
//   · review — words ALREADY saved; each rating just records a review (in-context
//              SRS practice). saveDictionaryWord is idempotent, so useTextQuiz
//              handles both with the same save-then-record path.
// Reuses the flashcard card/progress/grade UI from the review surface.
import { useTextQuiz, type OnGraded } from "../hooks/useTextQuiz";
import { FlashcardCard } from "../components/flashcards/FlashcardCard";
import { ProgressBar } from "../components/flashcards/ProgressBar";
import { useI18n, type MessageKey } from "../i18n";
import type { Word } from "../services/words/repository";
import type { ReviewGrade } from "../services/review";
import "../components/flashcards/flashcards.css";

const GRADES: ReviewGrade[] = [1, 2, 3, 4, 5];
const GRADE_KEY: Record<ReviewGrade, MessageKey> = {
  1: "review.grade1", 2: "review.grade2", 3: "review.grade3", 4: "review.grade4", 5: "review.grade5",
};

export type QuizMode = "learn" | "review";

export function TextQuizView({
  userId,
  words,
  mode = "learn",
  onGraded,
  onClose,
}: {
  userId: string;
  words: Word[];
  mode?: QuizMode;
  /** Sync the reader's saved/confidence state as each word is learned/reviewed. */
  onGraded?: OnGraded;
  /** Return to the reader. */
  onClose: () => void;
}) {
  // mode "learn" = NEW words (first-encounter recall), the right signal to
  // calibrate the user's level on — done silently in the hook (no UI here).
  const q = useTextQuiz(userId, words, { onGraded, calibrate: mode === "learn" });
  const { t } = useI18n();
  const noun = (n: number) => t(n === 1 ? "common.word" : "common.words");

  const close = (
    <button className="btn btn--ghost" onClick={onClose}>
      {t("quiz.back")}
    </button>
  );

  if (q.status === "empty") {
    return (
      <div className="review__msg">
        <p>{mode === "review" ? t("quiz.emptyReview") : t("quiz.emptyLearn")}</p>
        {close}
      </div>
    );
  }

  if (q.status === "done") {
    return (
      <div className="review__msg">
        <p>
          {mode === "review"
            ? t("quiz.doneReview", { n: q.reviewedCount, noun: noun(q.reviewedCount) })
            : t("quiz.doneLearn", { n: q.reviewedCount, noun: noun(q.reviewedCount) })}
        </p>
        <div className="review__foot">
          <button className="btn" onClick={q.restart}>
            {t("quiz.again")}
          </button>
          {close}
        </div>
      </div>
    );
  }

  const card = q.current!;
  return (
    <section className="review">
      <p className="review__scope">
        {mode === "review" ? t("quiz.scopeReview") : t("quiz.scopeLearn")}
      </p>
      <ProgressBar position={q.position} total={q.total} />

      <FlashcardCard word={card} flipped={q.flipped} onFlip={q.flip} />

      {q.error && <pre className="review__error">{q.error}</pre>}

      {q.flipped ? (
        <div className="grades" aria-label={t("review.recallAria")}>
          {GRADES.map((grade) => {
            const label = t(GRADE_KEY[grade]);
            return (
              <button
                key={grade}
                className={`grade grade--c${grade}`}
                disabled={q.submitting}
                onClick={() => q.grade(grade)}
                title={`${grade} — ${label}`}
              >
                <span className="grade__num">{grade}</span>
                <span className="grade__label">{label}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <button className="btn review__reveal" onClick={q.flip}>
          {t("review.reveal")}
        </button>
      )}

      <div className="review__foot">{close}</div>
    </section>
  );
}
