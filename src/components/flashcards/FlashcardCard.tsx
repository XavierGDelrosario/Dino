// One flashcard. Front shows the term only (recall the meaning); the back
// reveals the reading (furigana) + the translation. Readings come straight off
// the source row — authoritative for the no-context surface (see CLAUDE.md).
import { useRef } from "react";
import { useI18n } from "../../i18n";
import "./flashcards.css";

// A horizontal drag past this many px counts as a swipe (below it = a tap/scroll).
const SWIPE_THRESHOLD = 45;

/** The minimal face a card renders — satisfied by both a ReviewQueueItem (a saved
 *  UserWord) and a dictionary Word (the text-quiz path), so the card is reused. */
export interface CardFace {
  input: string;
  translation: string;
  inputReading: string | null;
  translationReading: string | null;
}

export function FlashcardCard({
  word,
  flipped,
  onFlip,
  onSwipeLeft,
  onSwipeRight,
}: {
  word: CardFace;
  flipped: boolean;
  onFlip: () => void;
  /** Optional horizontal-swipe handlers (e.g. cycle meanings). Left = next. */
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
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
      <div className="flashcard__term">{word.input}</div>

      {flipped ? (
        <div className="flashcard__back">
          {word.translationReading && (
            <div className="flashcard__reading">{word.translationReading}</div>
          )}
          {word.inputReading && (
            <div className="flashcard__reading">{word.inputReading}</div>
          )}
          <div className="flashcard__translation">{word.translation}</div>
        </div>
      ) : (
        <div className="flashcard__hint">{t("flashcard.tapToReveal")}</div>
      )}
    </div>
  );
}
