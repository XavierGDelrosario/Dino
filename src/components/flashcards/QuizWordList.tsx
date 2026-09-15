// The done screen's recap: every word the session just showed, under the Retry /
// New quiz buttons. Shared by BOTH flashcard quiz components (FlashcardView and
// TextQuizView) — a change to "the flashcard quiz" applies to every surface.
// Readings are the source row's (the no-context surface, like the card itself).
import { useI18n } from "../../i18n";
import type { CardFace } from "./FlashcardCard";
import "./flashcards.css";

export function QuizWordList({ words }: { words: (CardFace & { key: string })[] }) {
  const { t } = useI18n();
  if (words.length === 0) return null;
  return (
    <section className="quizwords" aria-label={t("quiz.wordsTitle")}>
      <p className="quizwords__title">{t("quiz.wordsTitle")}</p>
      <ul className="quizwords__list">
        {words.map((w) => (
          <li className="quizwords__row" key={w.key}>
            <span className="quizwords__term">
              {w.input}
              {w.inputReading && <span className="quizwords__reading">{w.inputReading}</span>}
            </span>
            <span className="quizwords__meaning">{w.translation}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
