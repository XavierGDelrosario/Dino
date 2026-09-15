// Level-based new-words quiz (Proficiency.md feature 2): pick a proficiency band
// (JLPT N5..N1 for Japanese), pull that many UNSEEN words from the dictionary
// source, and quiz them with the SAME save-then-review flashcard loop the reader's
// "Quiz N new words" uses (useTextQuiz, mode "learn"). Unlike the reader, the word
// set is sourced by LEVEL, not by a pasted text.
//
// The learning language decides the framework (services/proficiency): a language
// with no curated scale (or none ingested) shows nothing to pick. source = the
// language being learned, target = the language it is explained in (see explainIn).
//
// This tab's language picker is LOCAL: it seeds from the profile but never writes
// back, so studying something else here for one session leaves your saved languages
// alone. The placement quiz launched from here is handed the same on-screen value.
import { Suspense, lazy, useEffect, useState } from "react";
import { listUserLists, createList, type List } from "../services/lists";
import {
  proficiencyFrameworkFor,
  labelForBand,
  type ProficiencyFramework,
} from "../services/proficiency";
import { getUserProficiencyBand } from "../services/calibration";
import { useLanguagePrefs } from "../hooks/useLanguagePrefs";
import { fetchLearnWords } from "../services/learn";
import { CalibrationView } from "./CalibrationView";
// Lazy, like HomeView loaded it: Articles is a whole second surface (browse + the
// article analysis + its reader), and folding it into Learn's chunk would make the
// tab that everyone opens pay for the one they might not. It renders INLINE below the
// band buttons (see the bottom of the return), so the split is about bytes, not about
// whether the surface is visible.
const MediaView = lazy(() => import("./MediaView").then((m) => ({ default: m.MediaView })));
import {
  DEFAULT_LEARNING_LANGUAGE,
  DEFAULT_NATIVE_LANGUAGE,
  targetOptions,
  type LangCode,
} from "../services/language";
import { TextQuizView } from "./TextQuizView";
import { ErrorText } from "../components/common/ErrorText";
import { errorMessage } from "../lib/errorMessage";
import { useI18n } from "../i18n";
import type { Word } from "../services/words/repository";
import "../components/flashcards/flashcards.css";
import "./learn.css";

export function LearnView({ userId }: { userId: string }) {
  const { t } = useI18n();

  // The profile pair, through the ONE hook that owns the
  // getUserProfile → `?? DEFAULT` → warn policy (and the stale-load guard a
  // hand-rolled copy here kept losing). `prefs.ready` is its settled flag: the
  // embedded Articles browse waits on it so it doesn't fetch the DEFAULT language's
  // wiki and immediately refetch the real one. It is set on a FAILED read too.
  const prefs = useLanguagePrefs(userId);
  // OVERRIDDEN by this tab's own picker (see below). Null = follow the profile, so a
  // profile that lands late can never overwrite a choice the user already made.
  const [picked, setPicked] = useState<LangCode | null>(null);
  const learning = picked ?? prefs.learning;
  const native = prefs.native;
  const [lists, setLists] = useState<List[]>([]);
  useEffect(() => {
    listUserLists(userId)
      .then(setLists)
      .catch((e) => console.warn("LearnView: failed to load sub-lists", e));
  }, [userId]);

  /**
   * The language the drawn words are EXPLAINED in — the profile's native one, EXCEPT
   * when the tab's own picker has landed on that same language.
   *
   * A pair needs two different languages, and the edge rejects `source === target` with
   * a 400 raised before the learn branch — reported only as "Edge Function returned a
   * non-2xx status code", with nothing in error_log because the request never reaches
   * the part that logs. The defaults make it the first thing an EN-native tester hits:
   * learning JA + native EN, pick English here, and the pair collapses to EN→EN.
   *
   * Resolved LOCALLY and at read time, so the picker stays independent — nothing in
   * settings changes, and leaving the tab leaves no trace. Falls back to the registry
   * defaults (the other one of the pair) rather than scanning the registry by position.
   */
  const explainIn: LangCode =
    native !== learning
      ? native
      : learning !== DEFAULT_NATIVE_LANGUAGE
        ? DEFAULT_NATIVE_LANGUAGE
        : DEFAULT_LEARNING_LANGUAGE;

  const framework: ProficiencyFramework | null = proficiencyFrameworkFor(learning);

  const [band, setBand] = useState<number | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "quiz" | "empty" | "error">("idle");
  const [cards, setCards] = useState<Word[][]>([]);
  const [error, setError] = useState<string | null>(null);

  // The user's calibrated PROFICIENCY band (from the "Find my level" placement
  // quiz) — the band axis, shown as "your level: N3" + used to pre-highlight a band.
  // (users.level, the DIFFICULTY axis, is a separate value for the SRS/embeddings —
  // not shown here.) Reloaded when calibration finishes.
  const [level, setLevel] = useState<number | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  // Articles (the former Media tab) is a SECTION of Learn rather than a fifth tab or a
  // button that leads to one: browsing real news is one way of learning new words, the
  // same as drawing them from a band, so it sits under the bands as the other way in.
  // The one thing it still takes over for is the article ANALYSIS, which renders in the
  // embedded view's own slot — so when it opens, this tab's chrome folds away.
  const [articleOpen, setArticleOpen] = useState(false);
  const loadLevel = () =>
    getUserProficiencyBand(userId)
      .then(setLevel)
      .catch((e) => console.warn("LearnView: failed to load proficiency band", e));
  useEffect(() => {
    void loadLevel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  /** Create a sub-list and return its id (the quiz's add-to-list menu tags into it). */
  const createNamedList = async (name: string): Promise<string> => {
    const list = await createList({ userId, listName: name.trim() });
    setLists((ls) => [...ls, list]);
    return list.listId;
  };

  const start = async (b: number) => {
    setBand(b);
    setStatus("loading");
    setError(null);
    setCards([]);
    try {
      const fetched = await fetchLearnWords({ band: b, source: learning, target: explainIn });
      if (fetched.length === 0) {
        setStatus("empty");
      } else {
        setCards(fetched);
        setStatus("quiz");
      }
    } catch (e) {
      setError(errorMessage(e));
      setStatus("error");
    }
  };

  const reset = () => {
    setStatus("idle");
    setCards([]);
    setBand(null);
    setError(null);
  };

  // "Find my level" takeover: the placement quiz. On close, reload the stored level
  // so the hint + pre-highlighted band reflect the new result.
  if (calibrating) {
    return (
      <section className="review">
        <CalibrationView
          userId={userId}
          // The pair PICKED ON THIS SCREEN, not the profile: the quiz is launched from
          // a view that already has a language selector, and reading the profile
          // instead is what made "Find my level" deal Japanese cards after choosing
          // English here.
          langs={{ learning, native: explainIn }}
          lists={lists}
          onCreateList={createNamedList}
          onClose={() => {
            setCalibrating(false);
            void loadLevel();
          }}
        />
      </section>
    );
  }

  if (status === "quiz") {
    return (
      <section className="review">
        <TextQuizView
          userId={userId}
          cards={cards}
          lists={lists}
          mode="learn"
          // These cards came from a proficiency BAND, not a passage — without this the
          // session says "new words from this text" over words the user never saw in one.
          source="level"
          onCreateList={createNamedList}
          onClose={reset}
          // Pull a fresh batch at the same band (the just-added words are now saved,
          // so they're excluded as "unseen").
          onNewQuiz={band != null ? () => void start(band) : undefined}
        />
      </section>
    );
  }

  const bandLabel =
    framework && band != null ? framework.bands.find((b) => b.value === band)?.label : null;
  const levelLabel = framework && level != null ? labelForBand(framework, level) : null;

  return (
    <section className="review learn">
      {/* Everything above the Articles section hides while the article ANALYSIS is
          open: it renders inside the embedded browse below, so leaving the picker and
          the bands stacked on top of it would put a level quiz launcher over a page of
          prose. The browse itself stays MOUNTED throughout — moving it in the tree to
          "promote" it would remount it and lose the open article. */}
      {!articleOpen && (
        <>
          <label className="learn__lang">
            <span className="learn__langlabel">{t("learn.language")}</span>
            <select
              className="learn__langselect"
              value={learning}
              // LOCAL ONLY — this picker changes what THIS tab studies and nothing else.
              // It deliberately does not write to the profile: your saved languages are a
              // settings decision, and trying a different language here for one session
              // shouldn't rewrite them behind your back (an earlier version swapped the
              // native language to keep the pair valid, which is exactly the surprise this
              // avoids). The placement quiz reads this same value via `langs`, so the tab
              // stays self-consistent without touching anything outside it.
              onChange={(e) => {
                setPicked(e.target.value as LangCode);
                reset();
              }}
            >
              {targetOptions().map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>

          {/* Placement-quiz launcher + the current calibrated level (if any). */}
          <div className="learn__level">
            <span className="learn__levelnote">
              {levelLabel ? t("learn.yourLevel", { level: levelLabel }) : t("learn.noLevel")}
            </span>
            <button className="btn btn--ghost" onClick={() => setCalibrating(true)}>
              {levelLabel ? t("learn.recalibrate") : t("learn.findLevel")}
            </button>
          </div>

          {/* No framework for the learning language (or none ingested yet) → nothing to
              pick. Only the BANDS go; the Articles section below stays, because Wikinews is
              browsable in a language that has no proficiency scale ingested and gating it
              behind one would delete the surface for exactly those learners. */}
          {framework ? (
            <>
              <p className="learn__bandstitle">{t("learn.learnNewWords")}</p>
              <div className="tabs learn__bands" role="group" aria-label={t("learn.pickLevel")}>
                {framework.bands.map((b) => (
                  <button
                    key={b.value}
                    className={`tab${band === b.value ? " tab--active" : ""}`}
                    onClick={() => start(b.value)}
                    disabled={status === "loading"}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="review__msg">{t("learn.noFramework")}</p>
          )}

          {status === "loading" && <p className="review__msg">{t("learn.loading")}</p>}
          {status === "empty" && (
            <div className="review__msg">
              <p>{t("learn.empty", { level: bandLabel ?? "" })}</p>
            </div>
          )}
          {status === "error" && <ErrorText message={error} />}

          <p className="learn__bandstitle learn__articlestitle">{t("learn.articles")}</p>
        </>
      )}

      {/* The Wikinews browse ⇄ ★ Saved lists, in the flow under the bands — the second
          way into new words, not a place you navigate to. It owns no language of its
          own; this tab's picker is the one picker. */}
      <Suspense fallback={<p className="review__msg">{t("common.loading")}</p>}>
        <MediaView
          userId={userId}
          langs={{ learning, native: explainIn }}
          ready={prefs.ready}
          onArticleOpen={setArticleOpen}
        />
      </Suspense>
    </section>
  );
}
