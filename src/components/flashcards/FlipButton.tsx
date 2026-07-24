// The quiz direction toggle (top-right of a quiz screen). It states the mode it is
// switching TO, and because the swap is deferred to the next card the user gets no
// immediate effect — so the button itself has to carry the feedback: it fills in
// (is-on) for meaning-first, and while a toggle is armed but not yet showing it takes
// a highlight ring (is-pending) with a "next card" hint under it.
import { useI18n } from "../../i18n";
import type { QuizFlip } from "../../hooks/useQuizFlip";
import "./flashcards.css";

export function FlipButton({ flip }: { flip: QuizFlip }) {
  const { t } = useI18n();
  const { pending, pendingChange, toggle } = flip;

  return (
    <div className="quizflip">
      {pendingChange && <span className="quizflip__note">{t("quiz.flipNext")}</span>}
      <button
        type="button"
        className={`quizflip__btn${pending ? " is-on" : ""}${pendingChange ? " is-pending" : ""}`}
        onClick={toggle}
        aria-pressed={pending}
        aria-label={t("quiz.flipAria")}
        title={t("quiz.flipAria")}
      >
        <span aria-hidden="true">⇄</span>
        <span className="quizflip__label">
          {pending ? t("quiz.frontMeaning") : t("quiz.frontWord")}
        </span>
      </button>
    </div>
  );
}
