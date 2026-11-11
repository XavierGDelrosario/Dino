// A multiple-choice quiz on its own page (/quiz/<LANG>/<id>), opened from Learn's
// Quizzes section. One question at a time: pick an option → it is marked right/wrong at
// once, the explanation shows, "Next" moves on. The end screen gives the score, with
// "Try again" (a fresh shuffle) and the way back to Learn.
//
// Practice only — nothing is written to the vocabulary or review_log; the best score
// is remembered per device (quizResults.ts). Prose follows the profile's NATIVE
// language (pickLocalized), so the page is keyed on the pair like the lessons are.
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { Link } from "../router";
import { NoFooter } from "../components/common/NoFooter";
import { PageLoading } from "../components/common/Loading";
import { ErrorText } from "../components/common/ErrorText";
import { ProgressBar } from "../components/flashcards/ProgressBar";
import { useLanguagePrefs } from "../hooks/useLanguagePrefs";
import { otherLanguage, type LangCode } from "../services/language";
import {
  getQuiz,
  getQuizIndex,
  lessonAssetUrl,
  pickLocalized,
  type Quiz,
  type QuizOption,
  type QuizQuestion,
} from "../services/lessons";
import { recordQuizScore } from "./quizResults";
import "./lessons.css";

function shuffled<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** A question as DEALT: options in display order, `answer` re-pointed to match. */
interface Dealt {
  q: QuizQuestion;
  options: QuizOption[];
  answer: number;
}

function deal(quiz: Quiz): Dealt[] {
  const qs = quiz.shuffle ? shuffled(quiz.questions) : quiz.questions;
  return qs.map((q) => {
    const order = quiz.shuffleOptions ? shuffled(q.options.map((_, i) => i)) : q.options.map((_, i) => i);
    return { q, options: order.map((i) => q.options[i]), answer: order.indexOf(q.answer) };
  });
}

export function QuizPage({ userId, language, id }: { userId: string; language: LangCode; id: string }) {
  const { t } = useI18n();
  const prefs = useLanguagePrefs(userId);
  // The language the prose is explained in — never the quiz's own language.
  const native = prefs.native !== language ? prefs.native : otherLanguage(language);

  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [error, setError] = useState<"missing" | "failed" | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setQuiz(null);
    (async () => {
      const index = await getQuizIndex(language);
      const entry = index.lessons.find((q) => q.id === id);
      if (!entry) {
        if (!cancelled) setError("missing");
        return;
      }
      const q = await getQuiz(language, entry.file);
      if (!cancelled) setQuiz(q);
    })().catch((e) => {
      console.warn("QuizPage: could not load quiz", id, e);
      if (!cancelled) setError("failed");
    });
    return () => {
      cancelled = true;
    };
  }, [language, id, attempt]);

  // A new deal per quiz load and per "Try again" (round).
  const [round, setRound] = useState(0);
  const dealt = useMemo(() => (quiz ? deal(quiz) : []), [quiz, round]); // eslint-disable-line react-hooks/exhaustive-deps
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [correct, setCorrect] = useState(0);

  const restart = () => {
    setRound((r) => r + 1);
    setIndex(0);
    setPicked(null);
    setCorrect(0);
  };

  const back = (
    <Link to="/" className="btn btn--ghost quiz__back">
      {t("quizzes.back")}
    </Link>
  );

  if (error) {
    return (
      <section className="quiz">
        {back}
        <div className="review__msg">
          <ErrorText message={t(error === "missing" ? "quizzes.missing" : "quizzes.loadError")} />
          {error === "failed" && (
            <button type="button" className="btn btn--ghost" onClick={() => setAttempt((n) => n + 1)}>
              {t("lessons.retry")}
            </button>
          )}
        </div>
      </section>
    );
  }
  if (!quiz || dealt.length === 0) return <PageLoading />;

  const title = pickLocalized(quiz.title, native);
  const total = dealt.length;

  if (index >= total) {
    return (
      <section className="quiz">
        <NoFooter />
        {back}
        <h2 className="quiz__title">{title}</h2>
        <div className="quiz__done">
          <p className="quiz__score">{t("quizzes.score", { score: correct, total })}</p>
          <div className="quiz__actions">
            <button type="button" className="btn" onClick={restart}>
              {t("quizzes.tryAgain")}
            </button>
            <Link to="/" className="btn btn--ghost">
              {t("quizzes.backToLearn")}
            </Link>
          </div>
        </div>
      </section>
    );
  }

  const { q, options, answer } = dealt[index];
  const answered = picked !== null;
  const prompt = pickLocalized(q.prompt, native);
  const explanation = pickLocalized(q.explanation, native);

  const pick = (i: number) => {
    if (answered) return;
    setPicked(i);
    if (i === answer) setCorrect((n) => n + 1);
  };
  const next = () => {
    const last = index + 1 >= total;
    if (last) recordQuizScore(language, quiz.id, { score: correct, total });
    setPicked(null);
    setIndex((n) => n + 1);
  };

  return (
    <section className="quiz">
      <NoFooter />
      <div className="quiz__top">
        {back}
        {quiz.level && <span className="lesson__level">{quiz.level}</span>}
      </div>
      <h2 className="quiz__title">{title}</h2>
      <ProgressBar position={index + 1} total={total} />
      <p className="quiz__position">{t("quizzes.position", { n: index + 1, total })}</p>

      <div className="quiz__question">
        {prompt && <p className="quiz__prompt">{prompt}</p>}
        {q.image && (
          <img
            className="quiz__image"
            src={lessonAssetUrl(language, q.image.src)}
            alt={pickLocalized(q.image.alt, native)}
          />
        )}
        {q.text && (
          <p className="quiz__text" lang={language.toLowerCase()}>
            {q.text}
          </p>
        )}
      </div>

      <div className="quiz__options" role="group">
        {options.map((o, i) => {
          const state = !answered ? "" : i === answer ? " is-correct" : i === picked ? " is-wrong" : " is-dim";
          // A string is learning-language text; a map is a native-language answer.
          const learningText = typeof o === "string";
          return (
            <button
              key={`${index}-${i}`}
              type="button"
              className={`quiz__option${state}`}
              lang={(learningText ? language : native).toLowerCase()}
              disabled={answered}
              onClick={() => pick(i)}
            >
              {learningText ? o : pickLocalized(o, native)}
            </button>
          );
        })}
      </div>

      {answered && (
        <div className="quiz__feedback" role="status">
          <p className={picked === answer ? "is-correct" : "is-wrong"}>
            <strong>{t(picked === answer ? "lessons.correct" : "lessons.incorrect")}</strong>
            {explanation && <> {explanation}</>}
          </p>
          <button type="button" className="btn" onClick={next}>
            {index + 1 >= total ? t("quizzes.seeScore") : t("quizzes.next")}
          </button>
        </div>
      )}
    </section>
  );
}
