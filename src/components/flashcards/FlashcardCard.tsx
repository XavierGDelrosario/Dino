// One flashcard. Front shows the term only (recall the meaning); the back
// reveals the reading (furigana) + the translation. Readings come straight off
// the UserWord — authoritative for the no-context surface (see CLAUDE.md).
import type { ReviewQueueItem } from "../../services/review";
import "./flashcards.css";

export function FlashcardCard({
  word,
  flipped,
  onFlip,
}: {
  word: ReviewQueueItem;
  flipped: boolean;
  onFlip: () => void;
}) {
  return (
    <div
      className={`flashcard${flipped ? " flashcard--flipped" : ""}`}
      onClick={flipped ? undefined : onFlip}
      role={flipped ? undefined : "button"}
      tabIndex={flipped ? undefined : 0}
      onKeyDown={(e) => {
        if (!flipped && (e.key === "Enter" || e.key === " ")) onFlip();
      }}
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
        <div className="flashcard__hint">Tap to reveal</div>
      )}
    </div>
  );
}
