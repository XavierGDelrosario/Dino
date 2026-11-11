// A single-answer check inside a lesson (a `choice` block). A wrong pick is marked and
// stays marked, but the question stays open until the right one is chosen — the point
// is to end on the correct answer and its explanation, not to score the reader.
import { useState } from "react";
import { useI18n } from "../../i18n";
import { pickLocalized, type ChoiceBlock } from "../../services/lessons";
import type { LangCode } from "../../services/language";

export function LessonChoice({
  block,
  language,
  explainIn,
}: {
  block: ChoiceBlock;
  language: LangCode;
  /** The language the PROSE is shown in (the lesson page's switch). */
  explainIn: LangCode;
}) {
  const { t } = useI18n();
  const [wrong, setWrong] = useState<Set<number>>(new Set());
  const [solved, setSolved] = useState(false);
  const explanation = pickLocalized(block.explanation, explainIn);

  const pick = (i: number) => {
    if (solved) return;
    if (i === block.answer) setSolved(true);
    else setWrong((w) => new Set(w).add(i));
  };

  return (
    <div className="lesson__choice">
      <p className="lesson__choiceprompt">{pickLocalized(block.prompt, explainIn)}</p>
      <div className="lesson__options" role="group">
        {block.options.map((o, i) => {
          const state = solved && i === block.answer ? " is-correct" : wrong.has(i) ? " is-wrong" : "";
          return (
            <button
              key={i}
              type="button"
              className={`lesson__option${state}`}
              lang={language.toLowerCase()}
              disabled={solved || wrong.has(i)}
              onClick={() => pick(i)}
            >
              {o}
            </button>
          );
        })}
      </div>
      {solved ? (
        <p className="lesson__feedback is-correct" role="status">
          <strong>{t("lessons.correct")}</strong> {explanation}
        </p>
      ) : (
        wrong.size > 0 && (
          <p className="lesson__feedback is-wrong" role="status">
            {t("lessons.incorrect")}
          </p>
        )
      )}
    </div>
  );
}
