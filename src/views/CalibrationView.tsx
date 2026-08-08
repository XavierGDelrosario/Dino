// The "Find my level" placement quiz — a one-word-at-a-time SWIPE test. Swipe RIGHT
// (or → / the Know button) if you know the word, LEFT (or ← / Don't know) if you
// don't; tap the card to reveal the meaning; ＋ (top-right) files it into a sub-list.
//
// Each swipe saves the word (know → full confidence, don't-know → cold start), so
// your rated vocabulary IS the saved progress. The level is DERIVED from that whole
// vocabulary (stable — a few misses can't demote you) and is only COMMITTED once
// there's enough coverage; before that it shows a provisional "keep rating" state.
import { useCallback, useEffect } from "react";
import { useCalibration } from "../hooks/useCalibration";
import { FlashcardCard } from "../components/flashcards/FlashcardCard";
import { useSwipeCard } from "../components/flashcards/useSwipeCard";
import { AddToListButton } from "../components/translate/AddToListButton";
import { ErrorText } from "../components/common/ErrorText";
import { useI18n } from "../i18n";
import type { List } from "../services/lists";
import type { LangCode } from "../services/language";
import "../components/flashcards/flashcards.css";
import "./learn.css";
import "./calibration.css";

export function CalibrationView({
  userId,
  lists,
  onCreateList,
  onClose,
  langs,
}: {
  userId: string;
  lists: List[];
  onCreateList: (name: string) => Promise<string>;
  onClose: () => void;
  /** The pair to place the user in. Pass it from a screen that has its own language
   *  picker (Learn) — otherwise the quiz falls back to the profile and can contradict
   *  the choice the user just made to get here. */
  langs?: { learning: LangCode; native: LangCode };
}) {
  const c = useCalibration(userId, langs);
  const { t } = useI18n();
  const { status, current, revealed, reveal, rate } = c;

  // The card MOVES for every rating path — drag, buttons, keys all go through
  // fling(), so the rating lands only once the card has flown out.
  const swipe = useSwipeCard({
    onLeft: useCallback(() => rate(false), [rate]),
    onRight: useCallback(() => rate(true), [rate]),
  });
  const { fling } = swipe;

  // Web: ← = don't know, → = know, Space/Enter = reveal.
  useEffect(() => {
    if (status !== "swiping") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") fling("left");
      else if (e.key === "ArrowRight") fling("right");
      else if (e.key === " " || e.key === "Enter") reveal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, fling, reveal]);

  const close = (
    <button className="btn btn--ghost" onClick={onClose}>
      {t("calib.back")}
    </button>
  );

  if (status === "unavailable") {
    return (
      <section className="review">
        <p className="review__msg">{t("calib.unavailable")}</p>
        {close}
      </section>
    );
  }

  if (status === "error") {
    return (
      <section className="review">
        <ErrorText message={c.error} />
        <div className="review__foot">
          <button className="btn" onClick={c.restart}>{t("common.retry")}</button>
          {close}
        </div>
      </section>
    );
  }

  if (status === "done") {
    return (
      <section className="review">
        <div className="review__msg">
          <p className="calib__result">
            {c.bandLabel ? t("calib.resultLevel", { level: c.bandLabel }) : t("calib.resultBeginner")}
          </p>
        </div>
        <div className="review__foot">
          <button className="btn" onClick={c.restart}>{t("calib.again")}</button>
          {close}
        </div>
      </section>
    );
  }

  if (status === "loading" || !current) {
    return (
      <section className="review">
        <p className="review__msg">{t("calib.loading")}</p>
      </section>
    );
  }

  const sufficient = c.live?.sufficient ?? false;
  return (
    <section className="review calib">
      <div className="swipe">
        {/* Bigger fixed-size card; reveal by tapping it; ＋ add-to-list lives INSIDE.
            The swipe wrapper owns the gesture (so FlashcardCard's own touch-swipe
            props are deliberately NOT passed — both would rate the same release). */}
        <div {...swipe.props}>
          {/* Keyed on the word so the incoming card replays its settle-in. */}
          <div className="quizcard swipecard__in" key={current.wordId}>
            <FlashcardCard
              word={current}
              flipped={revealed}
              onFlip={reveal}
              action={
                <AddToListButton
                  className={`card-add${c.tagged.has(current.wordId) ? " is-saved" : ""}`}
                  words={[current]}
                  lists={lists}
                  label={c.tagged.has(current.wordId) ? "✓" : "＋"}
                  alreadyAdded={c.tagged.has(current.wordId)}
                  onAdd={(words, listId) => c.addToList(words[0], listId)}
                  onCreateList={onCreateList}
                />
              }
            />
          </div>
        </div>

        <ErrorText message={c.error} />

        {/* Web: buttons. App: swipe. They're alternatives, so the swipe hint sits
            right here with the buttons. */}
        <div className="swipe__controls">
          <button className="btn btn--ghost swipe__no" onClick={() => fling("left")}>
            ← {t("calib.dontKnow")}
          </button>
          <button className="btn btn--ghost swipe__yes" onClick={() => fling("right")}>
            {t("calib.know")} →
          </button>
        </div>
        <p className="swipe__hint">{t("calib.swipeHint")}</p>

        {/* Commit only once there's enough coverage — no counts, no "keep rating" noise. */}
        {sufficient && (
          <button className="btn btn--primary calib__finish" onClick={c.finish}>
            {t("calib.finish")}
          </button>
        )}

        <div className="review__foot">{close}</div>
      </div>
    </section>
  );
}
