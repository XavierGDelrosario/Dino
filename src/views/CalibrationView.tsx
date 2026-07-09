// The "Find my level" placement quiz (#10). A grid of words at one proficiency
// band — the user taps the ones they DON'T know, then advances. An adaptive binary
// search (useCalibration) converges on their level in a few quick rounds and stores
// it (users.level), which seeds the SRS for words added later. Words the user knows
// (left unmarked) are added to their vocabulary at full confidence. Deliberately
// fast: know/don't-know only, no meanings, no per-word grading.
import { useCalibration } from "../hooks/useCalibration";
import { ErrorText } from "../components/common/ErrorText";
import { SenseText } from "../components/common/SenseText";
import { AddToListButton } from "../components/translate/AddToListButton";
import { useI18n } from "../i18n";
import type { List } from "../services/lists";
import "./calibration.css";

export function CalibrationView({
  userId,
  lists,
  onCreateList,
  onClose,
}: {
  userId: string;
  /** The user's sub-lists, for the missed-word add-to-list menu. */
  lists: List[];
  /** Create a sub-list, returning its id (then the word is tagged into it). */
  onCreateList: (name: string) => Promise<string>;
  /** Return to the Learn picker. Called after a result so the caller can refresh
   *  the displayed level. */
  onClose: () => void;
}) {
  const c = useCalibration(userId);
  const { t } = useI18n();

  const close = (
    <button className="btn btn--ghost" onClick={onClose}>
      {t("calib.back")}
    </button>
  );

  if (c.status === "unavailable") {
    return (
      <section className="review">
        <p className="review__msg">{t("calib.unavailable")}</p>
        {close}
      </section>
    );
  }

  if (c.status === "error") {
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

  if (c.status === "done") {
    return (
      <section className="review">
        <div className="review__msg">
          <p className="calib__result">
            {c.levelLabel
              ? t("calib.resultLevel", { level: c.levelLabel })
              : t("calib.resultBeginner")}
          </p>
          {c.addedCount > 0 && (
            <p className="review__scope">{t("calib.resultSaved", { n: c.addedCount })}</p>
          )}
          <p className="review__scope">{t("calib.resultNote")}</p>
        </div>
        <div className="review__foot">
          <button className="btn" onClick={c.restart}>{t("calib.again")}</button>
          {close}
        </div>

        {/* The words the user didn't know, shown single-word-translate style so they
            can study them right after placing. */}
        {c.missed.length > 0 && (
          <div className="calib__missed">
            <p className="calib__missedtitle">{t("calib.missed")}</p>
            <ul className="calib__missedlist">
              {c.missed.map((w) => (
                <li className="calib__missedrow" key={w.wordId}>
                  <SenseText word={w} primary />
                  <AddToListButton
                    words={[w]}
                    lists={lists}
                    label={c.savedMissedIds.has(w.wordId) ? "✓" : "＋"}
                    alreadyAdded={c.savedMissedIds.has(w.wordId)}
                    onAdd={(words, listId) => c.addMissedWord(words[0], listId)}
                    onCreateList={onCreateList}
                    className="add"
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    );
  }

  // loading | reviewing
  return (
    <section className="review calib">
      <p className="review__scope">{t("calib.instruction")}</p>

      {c.status === "loading" ? (
        <p className="review__msg">{t("calib.loading")}</p>
      ) : (
        <>
          <p className="calib__round">{t("calib.round", { n: c.round })}</p>
          <div className="calib__grid" role="group" aria-label={t("calib.instruction")}>
            {c.cards.map((w, i) => {
              const marked = c.unknown.has(i);
              return (
                <button
                  key={w.wordId}
                  type="button"
                  className={`calcard${marked ? " is-unknown" : ""}`}
                  aria-pressed={marked}
                  onClick={() => c.toggle(i)}
                >
                  {w.inputReading && <span className="calcard__reading">{w.inputReading}</span>}
                  <span className="calcard__word">{w.input}</span>
                </button>
              );
            })}
          </div>

          <div className="calib__actions">
            <button className="btn" onClick={c.submit} disabled={c.submitting}>
              {c.unknownCount === 0
                ? t("calib.knowAll")
                : t("calib.next", { n: c.unknownCount })}
            </button>
          </div>
        </>
      )}

      <div className="review__foot">{close}</div>
    </section>
  );
}
