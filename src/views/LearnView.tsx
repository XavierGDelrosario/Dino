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
// The tab has NO language picker of its own: it studies the profile's learning
// language, set in one place (the profile page). A second, local picker here meant two
// answers to "what am I learning", and the placement quiz, the bands and Articles had
// to be kept agreeing with whichever one the user had last touched.
import { NoFooter } from "../components/common/NoFooter";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { listUserLists, createList, type List } from "../services/lists";
import {
  proficiencyFrameworkFor,
  labelForBand,
  type ProficiencyFramework,
} from "../services/proficiency";
import { getUserProficiencyBand } from "../services/calibration";
import { useLanguagePrefs } from "../hooks/useLanguagePrefs";
import { fetchLearnWords, nextLearnBatch, LEARN_BATCH } from "../services/learn";
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
  type LangCode,
} from "../services/language";
import { TextQuizView } from "./TextQuizView";
import { ErrorText } from "../components/common/ErrorText";
import { errorMessage } from "../lib/errorMessage";
import { useI18n } from "../i18n";
import type { Word } from "../services/words/repository";
import "../components/flashcards/flashcards.css";
import "./learn.css";
import { Loading } from "../components/common/Loading";

export function LearnView({ userId }: { userId: string }) {
  const { t } = useI18n();

  // The profile pair, through the ONE hook that owns the
  // getUserProfile → `?? DEFAULT` → warn policy (and the stale-load guard a
  // hand-rolled copy here kept losing). `prefs.ready` is its settled flag: the
  // embedded Articles browse waits on it so it doesn't fetch the DEFAULT language's
  // wiki and immediately refetch the real one. It is set on a FAILED read too.
  const prefs = useLanguagePrefs(userId);
  const learning = prefs.learning;
  const native = prefs.native;
  const [lists, setLists] = useState<List[]>([]);
  useEffect(() => {
    listUserLists(userId)
      .then(setLists)
      .catch((e) => console.warn("LearnView: failed to load sub-lists", e));
  }, [userId]);

  /**
   * The language the drawn words are EXPLAINED in — the profile's native one, EXCEPT
   * when the profile pair is the same language twice.
   *
   * A pair needs two different languages, and the edge rejects `source === target` with
   * a 400 raised before the learn branch — reported only as "Edge Function returned a
   * non-2xx status code", with nothing in error_log because the request never reaches
   * the part that logs. Falls back to the registry defaults (the other one of the pair)
   * rather than scanning the registry by position.
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
  // Bumped per batch: TextQuizView keys on it, so a prefetched batch swapped in without
  // a loading screen still remounts the quiz (useTextQuiz only re-arms on a new LENGTH,
  // and back-to-back batches are usually the same size).
  const [batch, setBatch] = useState(0);
  // The NEXT batch, fetched while the current one is quizzed so "New quiz" doesn't wait.
  // Keyed by band + pair: a different level or language never reuses it.
  const prefetched = useRef<{ key: string; promise: Promise<Word[][]>; ready: boolean } | null>(null);

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

  const batchKey = (b: number) => `${b}|${learning}|${explainIn}`;

  /** Start drawing the batch after `current` at band `b`, in the background. Over-fetches
   *  and drops the current batch's words (see nextLearnBatch). Never rejects. */
  const prefetchNext = (b: number, current: Word[][]) => {
    const entry = {
      key: batchKey(b),
      ready: false,
      promise: fetchLearnWords({ band: b, source: learning, target: explainIn, limit: LEARN_BATCH * 2 })
        .then((fetched) => nextLearnBatch(current, fetched))
        .catch(() => [] as Word[][]) // a failed prefetch just means "fetch normally"
        .finally(() => {
          entry.ready = true;
        }),
    };
    prefetched.current = entry;
  };

  const start = async (b: number) => {
    const pre = prefetched.current?.key === batchKey(b) ? prefetched.current : null;
    prefetched.current = null;
    setBand(b);
    setError(null);
    // A ready prefetch swaps straight in; anything else shows the loading state.
    if (!pre?.ready) {
      setStatus("loading");
      setCards([]);
    }
    try {
      let fetched = pre ? await pre.promise : [];
      if (fetched.length === 0) {
        setStatus("loading");
        setCards([]);
        fetched = await fetchLearnWords({ band: b, source: learning, target: explainIn, limit: LEARN_BATCH });
      }
      if (fetched.length === 0) {
        setStatus("empty");
      } else {
        setCards(fetched);
        setBatch((n) => n + 1);
        setStatus("quiz");
        prefetchNext(b, fetched);
      }
    } catch (e) {
      setError(errorMessage(e));
      setStatus("error");
    }
  };

  const reset = () => {
    prefetched.current = null;
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
        <NoFooter />
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
        <NoFooter />
        <TextQuizView
          key={batch}
          userId={userId}
          cards={cards}
          lists={lists}
          mode="learn"
          // These cards came from a proficiency BAND, not a passage — without this the
          // session says "new words from this text" over words the user never saw in one.
          source="level"
          onCreateList={createNamedList}
          onClose={reset}
          // A fresh batch at the same band — normally the one prefetched while this quiz
          // ran (see prefetchNext), so it opens without a wait.
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

          {status === "loading" && <p className="review__msg"><Loading text={t("learn.loading")} /></p>}
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
      <Suspense fallback={<p className="review__msg"><Loading text={t("common.loading")} /></p>}>
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
