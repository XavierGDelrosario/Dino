// The Quizzes section of Learn (registered in ./learn/sections): the multiple-choice
// quizzes published for the LEARNING language, grouped by level in collapsible groups.
// Opening one NAVIGATES to its own page (/quiz/<LANG>/<id> — QuizPage) rather than
// taking over the tab like a lesson: a quiz is a self-contained run with a score, and
// a real page gets a back button and a link of its own.
//
// Like Lessons, content is fetched (services/lessons, `<LANG>/quizzes/`), and a language
// with nothing published renders NOTHING, heading included. A finished quiz gets the
// same green outline + tint as a completed lesson, plus its best score — both kept
// per device (quizResults.ts).
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { useRouter } from "../router";
import { ErrorText } from "../components/common/ErrorText";
import { LevelGroups } from "../components/lessons/LevelGroups";
import { LearnSection } from "../components/lessons/LearnSection";
import { getQuizIndex, groupLessonsByLevel, pickLocalized, type LessonIndex } from "../services/lessons";
import { bestQuizScore, quizPath } from "./quizResults";
import type { LearnSectionProps } from "./learn/sections";
import "./lessons.css";

type State = { status: "idle" | "loading" | "error" } | { status: "ready"; index: LessonIndex };

export function QuizzesSection({ langs, ready, userLevel }: LearnSectionProps) {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setState({ status: "loading" });
    getQuizIndex(langs.learning)
      .then((index) => !cancelled && setState({ status: "ready", index }))
      .catch((e) => {
        console.warn("QuizzesSection: could not load quizzes", e);
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [ready, langs.learning, attempt]);

  if (state.status === "error") {
    return (
      <section className="lessons">
        <LearnSection id="quizzes" title={t("quizzes.title")}>
          <div className="review__msg">
          <ErrorText message={t("quizzes.loadError")} />
          <button type="button" className="btn btn--ghost" onClick={() => setAttempt((n) => n + 1)}>
            {t("lessons.retry")}
          </button>
          </div>
        </LearnSection>
      </section>
    );
  }
  if (state.status !== "ready" || state.index.lessons.length === 0) return null;

  return (
    <section className="lessons">
      <LearnSection id="quizzes" title={t("quizzes.title")}>
      <LevelGroups
        groups={groupLessonsByLevel(state.index.lessons, langs.learning)}
        storageKey={`quizzes.${langs.learning}`}
        userLevel={userLevel}
        renderItem={(q) => {
          const best = bestQuizScore(langs.learning, q.id);
          const summary = pickLocalized(q.summary, langs.native);
          return (
            <button
              type="button"
              className={`lessons__item${best ? " lessons__item--done" : ""}`}
              onClick={() => navigate(quizPath(langs.learning, q.id))}
            >
              <span className="lessons__itemtitle">{pickLocalized(q.title, langs.native)}</span>
              {summary && <span className="lessons__summary">{summary}</span>}
              {best && (
                <span className="lessons__score">{t("quizzes.best", { score: best.score, total: best.total })}</span>
              )}
            </button>
          );
        }}
      />
      </LearnSection>
    </section>
  );
}
