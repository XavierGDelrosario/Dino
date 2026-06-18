// Review session screen: reveal → rate confidence → next, over the N
// least-confident words. The grade is a 1–5 self-rated recall confidence
// (1 = forgot … 5 = easy); clicking a rating records it and advances.
import { useReview } from "../hooks/useReview";
import { FlashcardCard } from "../components/flashcards/FlashcardCard";
import { ProgressBar } from "../components/flashcards/ProgressBar";
import type { ReviewGrade } from "../services/review";
import "../components/flashcards/flashcards.css";

const CONFIDENCE: { grade: ReviewGrade; label: string }[] = [
  { grade: 1, label: "Forgot" },
  { grade: 2, label: "Hard" },
  { grade: 3, label: "OK" },
  { grade: 4, label: "Good" },
  { grade: 5, label: "Easy" },
];

export function FlashcardView({
  userId,
  listId = null,
  listName = "All words",
}: {
  userId: string;
  listId?: string | null;
  listName?: string;
}) {
  const r = useReview(userId, listId);

  const scope = <p className="review__scope">Reviewing: {listName}</p>;

  if (r.status === "loading") {
    return <p className="review__msg">Loading review…</p>;
  }

  if (r.status === "error") {
    return (
      <div className="review__msg">
        <p>Couldn’t load the review.</p>
        {r.error && <pre className="review__error">{r.error}</pre>}
        <button className="btn" onClick={r.restart}>
          Retry
        </button>
      </div>
    );
  }

  if (r.status === "empty") {
    return (
      <div className="review__msg">
        {scope}
        <p>
          {listId
            ? "No words in this list to review yet."
            : "Nothing to review yet — add some words to your vocabulary first."}
        </p>
      </div>
    );
  }

  if (r.status === "done") {
    return (
      <div className="review__msg">
        <p>
          Done — reviewed {r.reviewedCount}{" "}
          {r.reviewedCount === 1 ? "word" : "words"}. 🎉
        </p>
        <button className="btn" onClick={r.restart}>
          Review again
        </button>
      </div>
    );
  }

  const card = r.current!;
  return (
    <section className="review">
      {scope}
      <ProgressBar position={r.position} total={r.total} />

      <FlashcardCard word={card} flipped={r.flipped} onFlip={r.flip} />

      {r.error && <pre className="review__error">{r.error}</pre>}

      {r.flipped ? (
        <div className="grades" aria-label="How well did you recall it?">
          {CONFIDENCE.map(({ grade, label }) => (
            <button
              key={grade}
              className={`grade grade--c${grade}`}
              disabled={r.submitting}
              onClick={() => r.grade(grade)}
              title={`${grade} — ${label}`}
            >
              <span className="grade__num">{grade}</span>
              <span className="grade__label">{label}</span>
            </button>
          ))}
        </div>
      ) : (
        <button className="btn review__reveal" onClick={r.flip}>
          Reveal answer
        </button>
      )}
    </section>
  );
}
