// One flashcard. Front shows the term only (recall the meaning); the back
// reveals the reading (furigana) + the translation. Readings come straight off
// the source row — authoritative for the no-context surface (see CLAUDE.md).
//
// `reversed` swaps the two faces (meaning on the front, term revealed on the back)
// — a DISPLAY swap only; nothing about the word or its review changes. The readings
// stay on the REVEALED face in both directions: a reading on the front would hand
// the user the answer in the reversed direction (furigana spells out the term) and
// spoil the recall.
import { useRef } from "react";
import { WordInfoButton } from "../common/WordInfo";
import { useI18n } from "../../i18n";
import type { LangCode } from "../../services/language";
import "./flashcards.css";

// A horizontal drag past this many px counts as a swipe (below it = a tap/scroll).
const SWIPE_THRESHOLD = 45;

/** The minimal face a card renders — satisfied by both a ReviewQueueItem (a saved
 *  UserWord) and a dictionary Word (the text-quiz path), so the card is reused.
 *  The trailing four feed the shared "?" panel (Level + Commonness + POS). */
export interface CardFace {
  input: string;
  translation: string;
  inputReading: string | null;
  translationReading: string | null;
  sourceLang: LangCode;
  proficiencyBand: number | null;
  partOfSpeech: string[] | null;
  frequency: number | null;
}

export function FlashcardCard({
  word,
  flipped,
  onFlip,
  onSwipeLeft,
  onSwipeRight,
  reversed = false,
}: {
  word: CardFace;
  flipped: boolean;
  onFlip: () => void;
  /** Optional horizontal-swipe handlers (e.g. cycle meanings). Left = next. */
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  /** Show the MEANING on the front and the term on the back (display only). */
  reversed?: boolean;
}) {
  const { t } = useI18n();
  // Track the touch start so touchend can classify it as a horizontal swipe.
  const start = useRef<{ x: number; y: number } | null>(null);
  const swipeable = Boolean(onSwipeLeft || onSwipeRight);

  return (
    <div
      className={`flashcard${flipped ? " flashcard--flipped" : ""}`}
      onClick={flipped ? undefined : onFlip}
      role={flipped ? undefined : "button"}
      tabIndex={flipped ? undefined : 0}
      onKeyDown={(e) => {
        // Only the card itself flips — ignore key events bubbling up from the
        // focusable "?" button inside it (Enter there toggles the info panel).
        if (e.target !== e.currentTarget) return;
        if (!flipped && (e.key === "Enter" || e.key === " ")) onFlip();
      }}
      onTouchStart={
        swipeable
          ? (e) => { start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }
          : undefined
      }
      onTouchEnd={
        swipeable
          ? (e) => {
              if (!start.current) return;
              const dx = e.changedTouches[0].clientX - start.current.x;
              const dy = e.changedTouches[0].clientY - start.current.y;
              start.current = null;
              // Horizontal swipe only (ignore taps + vertical scrolls).
              if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) <= Math.abs(dy)) return;
              (dx < 0 ? onSwipeLeft : onSwipeRight)?.();
            }
          : undefined
      }
    >
      {/* Word-info "?" — same panel as a Lists row. Its click stops propagation so
          it never flips the card. Aligned left so the panel opens inward. */}
      <span className="flashcard__info" onClick={(e) => e.stopPropagation()}>
        <WordInfoButton word={word} align="left" />
      </span>

      <div className="flashcard__term">{reversed ? word.translation : word.input}</div>

      {flipped ? (
        <div className="flashcard__back">
          {word.translationReading && (
            <div className="flashcard__reading">{word.translationReading}</div>
          )}
          {word.inputReading && (
            <div className="flashcard__reading">{word.inputReading}</div>
          )}
          <div className="flashcard__translation">{reversed ? word.input : word.translation}</div>
        </div>
      ) : (
        <div className="flashcard__hint">{t("flashcard.tapToReveal")}</div>
      )}
    </div>
  );
}
