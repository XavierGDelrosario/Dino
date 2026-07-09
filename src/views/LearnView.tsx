// Level-based new-words quiz (Proficiency.md feature 2): pick a proficiency band
// (JLPT N5..N1 for Japanese), pull that many UNSEEN words from the dictionary
// source, and quiz them with the SAME save-then-review flashcard loop the reader's
// "Quiz N new words" uses (useTextQuiz, mode "learn"). Unlike the reader, the word
// set is sourced by LEVEL, not by a pasted text.
//
// The learning language decides the framework (services/proficiency): a language
// with no curated scale (or none ingested) shows nothing to pick. source = the
// language being learned, target = the user's native language, mirroring Translate.
import { useEffect, useState } from "react";
import { getUserProfile } from "../services/session";
import { listUserLists, createList, type List } from "../services/lists";
import {
  proficiencyFrameworkFor,
  labelForBand,
  type ProficiencyFramework,
} from "../services/proficiency";
import { getUserProficiencyBand } from "../services/calibration";
import { fetchLearnWords } from "../services/learn";
import { CalibrationView } from "./CalibrationView";
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

export function LearnView({ userId }: { userId: string }) {
  const { t } = useI18n();

  // Directions from the user's profile (learning = source, native = target),
  // falling back to the registry defaults for a fresh guest.
  const [learning, setLearning] = useState<LangCode>(DEFAULT_LEARNING_LANGUAGE);
  const [native, setNative] = useState<LangCode>(DEFAULT_NATIVE_LANGUAGE);
  const [lists, setLists] = useState<List[]>([]);
  useEffect(() => {
    getUserProfile(userId)
      .then((p) => {
        setLearning((p?.learningLanguage ?? DEFAULT_LEARNING_LANGUAGE) as LangCode);
        setNative((p?.nativeLanguage ?? DEFAULT_NATIVE_LANGUAGE) as LangCode);
      })
      .catch((e) => console.warn("LearnView: failed to load language prefs", e));
    listUserLists(userId)
      .then(setLists)
      .catch((e) => console.warn("LearnView: failed to load sub-lists", e));
  }, [userId]);

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
    try {
      const fetched = await fetchLearnWords({ band: b, source: learning, target: native });
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

  // No framework for the learning language (or none ingested yet) → nothing to do.
  if (!framework) {
    return (
      <section className="review">
        <p className="review__msg">{t("learn.noFramework")}</p>
      </section>
    );
  }

  // "Find my level" takeover: the placement quiz. On close, reload the stored level
  // so the hint + pre-highlighted band reflect the new result.
  if (calibrating) {
    return (
      <section className="review">
        <CalibrationView
          userId={userId}
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
        {/* onGraded is omitted: there's no reader to sync, and re-fetching a band
            after a session naturally excludes the just-added words (they're now
            saved, so no longer "unseen"). */}
        <TextQuizView
          userId={userId}
          cards={cards}
          lists={lists}
          mode="learn"
          onCreateList={createNamedList}
          onClose={reset}
          // Pull a FRESH batch at the same band. The just-added words are now saved,
          // so they're excluded as "unseen" — the next batch is genuinely new. The
          // brief "loading" state remounts TextQuizView with the new cards.
          onNewQuiz={band != null ? () => void start(band) : undefined}
        />
      </section>
    );
  }

  const bandLabel = band != null ? framework.bands.find((b) => b.value === band)?.label : null;
  const levelLabel = level != null ? labelForBand(framework, level) : null;
  // The band to hint as "your level" — the calibrated one if we have it.
  const suggestedBand = band ?? level;

  return (
    <section className="review learn">
      <p className="review__scope">{t("learn.intro", { framework: framework.name })}</p>

      {/* Placement-quiz launcher + the current calibrated level (if any). */}
      <div className="learn__level">
        <span className="learn__levelnote">
          {levelLabel ? t("learn.yourLevel", { level: levelLabel }) : t("learn.noLevel")}
        </span>
        <button className="btn btn--ghost" onClick={() => setCalibrating(true)}>
          {levelLabel ? t("learn.recalibrate") : t("learn.findLevel")}
        </button>
      </div>

      <div className="tabs learn__bands" role="group" aria-label={t("learn.pickLevel")}>
        {framework.bands.map((b) => (
          <button
            key={b.value}
            className={`tab${band === b.value ? " tab--active" : ""}${
              band == null && suggestedBand === b.value ? " tab--suggested" : ""
            }`}
            onClick={() => start(b.value)}
            disabled={status === "loading"}
          >
            {b.label}
          </button>
        ))}
      </div>

      {status === "loading" && <p className="review__msg">{t("learn.loading")}</p>}
      {status === "empty" && (
        <div className="review__msg">
          <p>{t("learn.empty", { level: bandLabel ?? "" })}</p>
        </div>
      )}
      {status === "error" && <ErrorText message={error} />}
      {status === "idle" && <p className="review__msg">{t("learn.hint")}</p>}
    </section>
  );
}
