// The done screen's note for grades that didn't reach the server. Shared by both
// flashcard quizzes (FlashcardView + TextQuizView) so they say the same thing. The grades
// are kept in the hook, so "Retry" re-sends them — nobody has to grade the cards again.
import { useI18n } from "../../i18n";
import { ErrorText } from "../common/ErrorText";

export function SaveFailures({
  count,
  error,
  onRetry,
}: {
  count: number;
  error: string | null;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  if (count === 0) return null;
  return (
    <div className="quiz__savefail" role="alert">
      <p>{t("quiz.saveFailed", { n: count })}</p>
      <ErrorText message={error} />
      <button className="btn" onClick={onRetry}>
        {t("quiz.retrySave")}
      </button>
    </div>
  );
}
