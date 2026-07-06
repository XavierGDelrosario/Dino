// Review session screen: reveal → rate confidence → next, over the N
// least-confident words. The grade is a 1–5 self-rated recall confidence
// (1 = forgot … 5 = easy); clicking a rating records it and advances.
import { useReview } from "../hooks/useReview";
import { FlashcardCard } from "../components/flashcards/FlashcardCard";
import { ProgressBar } from "../components/flashcards/ProgressBar";
import { GradeBar } from "../components/flashcards/GradeBar";
import { useI18n, plural } from "../i18n";
import { ErrorText } from "../components/common/ErrorText";
import "../components/flashcards/flashcards.css";

export function FlashcardView({
  userId,
  listId = null,
  listName,
  userWordIds,
}: {
  userId: string;
  listId?: string | null;
  listName?: string;
  /** When set, quiz exactly these words (the Lists view's filtered subset). */
  userWordIds?: string[];
}) {
  const r = useReview(userId, listId, undefined, userWordIds);
  const { t } = useI18n();
  const scopeName = listName || t("lists.allWords");
  const noun = (n: number) => plural(t, n, "common.word", "common.words");

  const scope = <p className="review__scope">{t("review.scope", { name: scopeName })}</p>;

  if (r.status === "loading") {
    return <p className="review__msg">{t("review.loading")}</p>;
  }

  if (r.status === "error") {
    return (
      <div className="review__msg">
        <p>{t("review.errorTitle")}</p>
        <ErrorText message={r.error} />
        <button className="btn" onClick={r.restart}>
          {t("common.retry")}
        </button>
      </div>
    );
  }

  if (r.status === "empty") {
    return (
      <div className="review__msg">
        {scope}
        <p>{listId ? t("review.emptyList") : t("review.emptyAll")}</p>
      </div>
    );
  }

  if (r.status === "done") {
    return (
      <div className="review__msg">
        <p>{t("review.done", { n: r.reviewedCount, noun: noun(r.reviewedCount) })}</p>
        <button className="btn" onClick={r.restart}>
          {t("review.again")}
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

      <ErrorText message={r.error} />

      <GradeBar flipped={r.flipped} submitting={r.submitting} onReveal={r.flip} onGrade={r.grade} />
    </section>
  );
}
