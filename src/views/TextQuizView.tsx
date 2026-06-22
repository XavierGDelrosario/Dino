// Quiz session over the words in a pasted text, reveal → rate → next. Two modes:
//   · learn  — the NEW words; each rating ADDS the word + records a first review.
//   · review — words ALREADY saved; each rating just records a review (in-context
//              SRS practice). saveDictionaryWord is idempotent, so useTextQuiz
//              handles both with the same save-then-record path.
// Reuses the flashcard card/progress/grade UI from the review surface.
import { useTextQuiz, type OnGraded } from "../hooks/useTextQuiz";
import { FlashcardCard } from "../components/flashcards/FlashcardCard";
import { ProgressBar } from "../components/flashcards/ProgressBar";
import type { Word } from "../services/words/repository";
import type { ReviewGrade } from "../services/review";
import "../components/flashcards/flashcards.css";

const CONFIDENCE: { grade: ReviewGrade; label: string }[] = [
  { grade: 1, label: "Forgot" },
  { grade: 2, label: "Hard" },
  { grade: 3, label: "OK" },
  { grade: 4, label: "Good" },
  { grade: 5, label: "Easy" },
];

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
  const q = useTextQuiz(userId, words, { onGraded });

  const close = (
    <button className="btn btn--ghost" onClick={onClose}>
      ← Back to reader
    </button>
  );

  if (q.status === "empty") {
    return (
      <div className="review__msg">
        <p>
          {mode === "review"
            ? "No saved words in this text to review yet."
            : "No new words in this text to quiz — you know them all. 🎉"}
        </p>
        {close}
      </div>
    );
  }

  if (q.status === "done") {
    return (
      <div className="review__msg">
        <p>
          {mode === "review"
            ? `Reviewed ${q.reviewedCount} ${q.reviewedCount === 1 ? "word" : "words"}. 🎉`
            : `Added ${q.reviewedCount} new ${q.reviewedCount === 1 ? "word" : "words"} to your vocabulary. 🎉`}
        </p>
        <div className="review__foot">
          <button className="btn" onClick={q.restart}>
            Quiz again
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
        {mode === "review"
          ? "Reviewing words from this text"
          : "Quizzing new words from this text"}
      </p>
      <ProgressBar position={q.position} total={q.total} />

      <FlashcardCard word={card} flipped={q.flipped} onFlip={q.flip} />

      {q.error && <pre className="review__error">{q.error}</pre>}

      {q.flipped ? (
        <div className="grades" aria-label="How well did you recall it?">
          {CONFIDENCE.map(({ grade, label }) => (
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
          ))}
        </div>
      ) : (
        <button className="btn review__reveal" onClick={q.flip}>
          Reveal answer
        </button>
      )}

      <div className="review__foot">{close}</div>
    </section>
  );
}
