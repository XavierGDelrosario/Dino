// The flashcard answer control, shared by the review loop (FlashcardView) and the
// text quiz (TextQuizView): before the card is flipped it's a single "Reveal"
// button; once revealed it's the 1–5 confidence grade grid. Both surfaces had this
// block verbatim.
import { useI18n } from "../../i18n";
import { GRADES, GRADE_KEY } from "./grades";
import type { ReviewGrade } from "../../services/review";

export function GradeBar({
  flipped,
  submitting,
  onReveal,
  onGrade,
}: {
  flipped: boolean;
  submitting: boolean;
  onReveal: () => void;
  onGrade: (grade: ReviewGrade) => void;
}) {
  const { t } = useI18n();

  if (!flipped) {
    return (
      <button className="btn review__reveal" onClick={onReveal}>
        {t("review.reveal")}
      </button>
    );
  }

  return (
    <div className="grades" aria-label={t("review.recallAria")}>
      {GRADES.map((grade) => {
        const label = t(GRADE_KEY[grade]);
        return (
          <button
            key={grade}
            className={`grade grade--c${grade}`}
            disabled={submitting}
            onClick={() => onGrade(grade)}
            title={`${grade} — ${label}`}
          >
            <span className="grade__num">{grade}</span>
            <span className="grade__label">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
