// The Lessons section of Learn (registered in ./learn/sections): the lessons published
// for the LEARNING language, grouped by level, and — when one is opened — the lesson
// page, which takes over the tab.
//
// Content is fetched, not bundled (services/lessons), so this renders whatever the
// bucket holds right now. A language with nothing published renders NOTHING, heading
// included — an empty "Lessons" heading would read as a broken feature.
//
// "Completed" (a green outline + tint on the card) is a per-device mark in localStorage: a convenience, not progress the
// app reasons about. Cross-device progress would be a table keyed on user_id.
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { ErrorText } from "../components/common/ErrorText";
import { LessonView } from "./LessonView";
import {
  getLessonIndex,
  groupLessonsByLevel,
  pickLocalized,
  type LessonIndex,
  type LessonSummary,
} from "../services/lessons";
import type { LearnSectionProps } from "./learn/sections";
import "./lessons.css";

const DONE_KEY = "dino.lessons.done";

function readDone(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DONE_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
function writeDone(done: Set<string>): void {
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify([...done]));
  } catch {
    /* blocked storage — the mark just won't persist */
  }
}
/** Completion is per learning language: the same id may exist in two folders. */
const doneKey = (language: string, id: string) => `${language.toUpperCase()}:${id}`;

type State = { status: "idle" | "loading" | "error" } | { status: "ready"; index: LessonIndex };

export function LessonsSection({ userId, langs, ready, onTakeover }: LearnSectionProps) {
  const { t } = useI18n();
  const [state, setState] = useState<State>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<LessonSummary | null>(null);
  const [done, setDone] = useState<Set<string>>(readDone);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setState({ status: "loading" });
    setOpen(null); // a lesson from the previous learning language can't stay open
    getLessonIndex(langs.learning)
      .then((index) => !cancelled && setState({ status: "ready", index }))
      .catch((e) => {
        console.warn("LessonsSection: could not load lessons", e);
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [ready, langs.learning, attempt]);

  useEffect(() => {
    onTakeover(open != null);
  }, [open, onTakeover]);

  if (open) {
    const key = doneKey(langs.learning, open.id);
    return (
      <LessonView
        key={open.file}
        userId={userId}
        langs={langs}
        summary={open}
        completed={done.has(key)}
        onBack={() => setOpen(null)}
        onFinish={() => {
          const next = new Set(done).add(key);
          setDone(next);
          writeDone(next);
          setOpen(null);
        }}
      />
    );
  }

  if (state.status === "error") {
    return (
      <section className="lessons">
        <p className="learn__bandstitle learn__articlestitle">{t("lessons.title")}</p>
        <div className="review__msg">
          <ErrorText message={t("lessons.loadError")} />
          <button type="button" className="btn btn--ghost" onClick={() => setAttempt((n) => n + 1)}>
            {t("lessons.retry")}
          </button>
        </div>
      </section>
    );
  }
  // Loading renders nothing rather than a spinner: most languages answer "no lessons",
  // and a heading that appears and then vanishes is worse than one that appears late.
  if (state.status !== "ready" || state.index.lessons.length === 0) return null;

  const groups = groupLessonsByLevel(state.index.lessons, langs.learning);
  return (
    <section className="lessons">
      <p className="learn__bandstitle learn__articlestitle">{t("lessons.title")}</p>
      {groups.map((g) => (
        <div key={g.level ?? "other"} className="lessons__group">
          {groups.length > 1 || g.level ? (
            <p className="lessons__level">{g.level ?? t("lessons.other")}</p>
          ) : null}
          <ul className="lessons__list">
            {g.lessons.map((l) => {
              const isDone = done.has(doneKey(langs.learning, l.id));
              const summary = pickLocalized(l.summary, langs.native);
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    className={`lessons__item${isDone ? " lessons__item--done" : ""}`}
                    onClick={() => setOpen(l)}
                    // Completion is shown by the green outline + tint alone; this keeps
                    // it announced for a screen reader.
                    aria-description={isDone ? t("lessons.completed") : undefined}
                  >
                    <span className="lessons__itemtitle">{pickLocalized(l.title, langs.native)}</span>
                    {summary && <span className="lessons__summary">{summary}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
