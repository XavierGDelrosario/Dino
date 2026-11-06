// The quiz direction toggle (top-right of a quiz screen). It names the language
// that will face up, as the CARD's own stored code — word first shows its
// `sourceLang` (JA), meaning first its `targetLang` (EN) — or 🎲 for a coin toss per
// card; each click cycles to the next of the three. Reading the codes off the card
// (not off a profile or a fixed pair) is what keeps it right for any language.
// The change is deferred to the next card, so the user gets no immediate effect and
// the button itself carries the feedback: it fills in (is-on) for anything but the
// default word-first, and while a change is armed but not yet showing it takes a
// highlight ring (is-pending) with a "next card" hint under it.
import { useI18n } from "../../i18n";
import type { QuizFlip } from "../../hooks/useQuizFlip";
import type { LangCode } from "../../services/language";
import "./flashcards.css";

export function FlipButton({
  flip,
  wordLang,
  meaningLang,
}: {
  flip: QuizFlip;
  /** The current card's word language (its source side). */
  wordLang: LangCode;
  /** The current card's meaning language (its target side). */
  meaningLang: LangCode;
}) {
  const { t } = useI18n();
  const { pending, pendingChange, cycle } = flip;
  const label = pending === "random" ? "🎲" : pending === "word" ? wordLang : meaningLang;
  const state =
    pending === "random" ? t("quiz.frontRandom") : pending === "word" ? t("quiz.frontWord") : t("quiz.frontMeaning");

  return (
    <div className="quizflip">
      {pendingChange && <span className="quizflip__note">{t("quiz.flipNext")}</span>}
      <button
        type="button"
        className={`quizflip__btn${pending !== "word" ? " is-on" : ""}${pendingChange ? " is-pending" : ""}`}
        onClick={cycle}
        aria-label={`${t("quiz.flipAria")}: ${state}`}
        title={state}
      >
        {label}
      </button>
    </div>
  );
}
