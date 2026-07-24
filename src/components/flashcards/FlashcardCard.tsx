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

/** Visual width of a string in "columns": CJK/kana/fullwidth glyphs occupy roughly
 *  twice the advance of a Latin letter, so 五十音 and "procrastination" can't be
 *  compared by `.length`. This is why a fixed font size looked right in Japanese and
 *  wrong in English — 4 kanji and 15 Latin letters are about the same ink. */
function displayColumns(text: string): number {
  let cols = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||   // Hangul Jamo
      (c >= 0x2e80 && c <= 0xa4cf) ||   // CJK radicals … Yi (incl. kana, kanji)
      (c >= 0xac00 && c <= 0xd7a3) ||   // Hangul syllables
      (c >= 0xf900 && c <= 0xfaff) ||   // CJK compatibility ideographs
      (c >= 0xff00 && c <= 0xff60) ||   // fullwidth forms
      (c >= 0x20000 && c <= 0x3fffd);   // CJK extension planes
    cols += wide ? 2 : 1;
  }
  return cols;
}

/** Shrink text past `fits` columns, proportionally, down to `min`. Returns a style
 *  rather than a class so the step is smooth — a three-bucket class ladder visibly
 *  jumps between cards, which reads as a rendering glitch. */
function fitToWidth(text: string, max: number, min: number, fits: number) {
  const cols = displayColumns(text);
  if (cols <= fits) return undefined;
  const size = Math.max(min, (max * fits) / cols);
  return { fontSize: `${size.toFixed(2)}rem` };
}

// Column budgets: how much text each face holds at full size before it shrinks.
// Tuned against the narrowest supported card (a phone at 320px).
const TERM_MAX = 2.4, TERM_MIN = 1.15, TERM_FITS = 9;
const MEANING_MAX = 1.4, MEANING_MIN = 0.95, MEANING_FITS = 26;

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

      {/* Both faces can hold either side's text (see `reversed`), and a meaning is
          usually far longer than a headword — so each is sized from what it renders. */}
      <div
        className="flashcard__term"
        style={fitToWidth(
          reversed ? word.translation : word.input,
          TERM_MAX,
          TERM_MIN,
          TERM_FITS
        )}
      >
        {reversed ? word.translation : word.input}
      </div>

      {flipped ? (
        <div className="flashcard__back">
          {word.translationReading && (
            <div className="flashcard__reading">{word.translationReading}</div>
          )}
          {word.inputReading && (
            <div className="flashcard__reading">{word.inputReading}</div>
          )}
          <div
            className="flashcard__translation"
            style={fitToWidth(
              reversed ? word.input : word.translation,
              MEANING_MAX,
              MEANING_MIN,
              MEANING_FITS
            )}
          >
            {reversed ? word.input : word.translation}
          </div>
        </div>
      ) : (
        <div className="flashcard__hint">{t("flashcard.tapToReveal")}</div>
      )}
    </div>
  );
}
