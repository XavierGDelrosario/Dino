// Quiz session over the words in a pasted text, reveal → rate → next. Two modes:
//   · learn  — the NEW words; each rating ADDS the word + records a first review.
//   · review — words ALREADY saved; each rating just records a review (in-context
//              SRS practice). saveDictionaryWord is idempotent, so useTextQuiz
//              handles both with the same save-then-record path.
// Reuses the flashcard card/progress/grade UI from the review surface.
import { useTextQuiz, type OnGraded } from "../hooks/useTextQuiz";
import { FlashcardCard } from "../components/flashcards/FlashcardCard";
import { ProgressBar } from "../components/flashcards/ProgressBar";
import { useI18n } from "../i18n";
import { GRADES, GRADE_KEY } from "../components/flashcards/grades";
import type { Word } from "../services/words/repository";
import "../components/flashcards/flashcards.css";

export type QuizMode = "learn" | "review";

export function TextQuizView({
  userId,
  cards,
  mode = "learn",
  onGraded,
  onClose,
}: {
  userId: string;
  /** One entry per word — its full sense list (primary first) so meanings cycle. */
  cards: Word[][];
  mode?: QuizMode;
  /** Sync the reader's saved/confidence state as each word is learned/reviewed. */
  onGraded?: OnGraded;
  /** Return to the reader. */
  onClose: () => void;
}) {
  // mode "learn" = NEW words (first-encounter recall), the right signal to
  // calibrate the user's level on — done silently in the hook (no UI here).
  const q = useTextQuiz(userId, cards, { onGraded, calibrate: mode === "learn" });
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

      {/* The card + a top-right ＋ add-to-list button (adds the SELECTED meaning,
          which defaults to the first) and ←/→ meaning-cycle arrows when the word
          has more than one sense. */}
      <div className="quizcard">
        <button
          className={`quizcard__add${q.isCurrentSaved ? " is-saved" : ""}`}
          onClick={q.addCurrent}
          disabled={q.submitting || q.isCurrentSaved}
          title={q.isCurrentSaved ? t("quiz.added") : t("quiz.addToList")}
          aria-label={q.isCurrentSaved ? t("quiz.added") : t("quiz.addToList")}
        >
          {q.isCurrentSaved ? "✓" : "＋"}
        </button>

        <FlashcardCard word={card} flipped={q.flipped} onFlip={q.flip} />

        {/* Meaning-cycle arrows appear only once the meaning is REVEALED — before
            that the card is a recall test, so cycling senses would spoil it. */}
        {q.hasMultipleMeanings && q.flipped && (
          <div className="quizcard__meaningnav">
            <button
              className="quizcard__arrow"
              onClick={q.prevMeaning}
              aria-label={t("quiz.prevMeaning")}
            >
              ‹
            </button>
            <span className="quizcard__meaningpos">
              {t("quiz.meaningPos", { i: q.meaningIndex + 1, n: q.senses.length })}
            </span>
            <button
              className="quizcard__arrow"
              onClick={q.nextMeaning}
              aria-label={t("quiz.nextMeaning")}
            >
              ›
            </button>
          </div>
        )}
      </div>

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
