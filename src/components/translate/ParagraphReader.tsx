// Presentational sentence reader. Each word is colored by knowledge (grey = not
// in dictionary · blue = addable · red→green by confidence once in vocab). HOVER
// a word for a popover listing EVERY sense, each with its own add button — so a
// homograph (辛い → からい / つらい) lets you add the exact meaning you want, not
// just the primary. Already-saved senses show their confidence + a "don't know"
// (a review lapse). All state lives in the parent (useTranslate).
import { useRef, useState } from "react";
import { isContentPos, type AnalyzedToken } from "../../services/language";
import type { Word } from "../../services/words/repository";
import "./translate.css";
import "../common/SenseText.css"; // shared .sense* row/action styles

export function ParagraphReader({
  text,
  tokens,
  meaningsByWord,
  saved,
  saving,
  confidence,
  onAdd,
  onMarkUnknown,
}: {
  text: string;
  tokens: AnalyzedToken[];
  meaningsByWord: Map<string, Word[]>;
  saved: Set<string>;
  saving: Set<string>;
  confidence: Map<string, number>;
  onAdd: (sense: Word) => void;
  onMarkUnknown: (sense: Word) => void;
}) {
  const [hover, setHover] = useState<{ word: string; rect: DOMRect } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = (word: string, el: HTMLElement) => {
    clearTimeout(hideTimer.current);
    setHover({ word, rect: el.getBoundingClientRect() });
  };
  const scheduleHide = () => {
    hideTimer.current = setTimeout(() => setHover(null), 120);
  };
  const cancelHide = () => clearTimeout(hideTimer.current);

  // Knowledge class for a token: grey (grammatical / no entry) · blue (addable) ·
  // red→green by the confidence of its best-known sense.
  const classFor = (token: AnalyzedToken): { cls: string; interactive: boolean } => {
    const senses = isContentPos(token.pos) ? meaningsByWord.get(token.text) ?? [] : [];
    if (senses.length === 0) return { cls: "tok tok--plain", interactive: false };
    const savedSenses = senses.filter((s) => saved.has(s.wordId));
    if (savedSenses.length === 0) return { cls: "tok tok--new", interactive: true };
    const best = Math.max(...savedSenses.map((s) => confidence.get(s.wordId) ?? 0));
    return { cls: `tok tok--known tok--c${best}`, interactive: true };
  };

  const parts: JSX.Element[] = [];
  let cursor = 0;
  tokens.forEach((t, i) => {
    if (t.start > cursor) parts.push(<span key={`gap-${i}`}>{text.slice(cursor, t.start)}</span>);
    const { cls, interactive } = classFor(t);
    parts.push(
      <span
        key={`tok-${i}`}
        className={cls}
        onMouseEnter={interactive ? (e) => show(t.text, e.currentTarget) : undefined}
        onMouseLeave={interactive ? scheduleHide : undefined}
      >
        {t.text}
      </span>
    );
    cursor = Math.max(cursor, t.end);
  });
  if (cursor < text.length) parts.push(<span key="gap-end">{text.slice(cursor)}</span>);

  const hoveredSenses = hover ? meaningsByWord.get(hover.word) ?? [] : [];

  return (
    <>
      <p className="reader">{parts}</p>
      {hover && hoveredSenses.length > 0 && (
        <div
          className="hovercard"
          style={{
            position: "fixed",
            top: Math.round(hover.rect.bottom + 6),
            left: Math.round(Math.min(hover.rect.left, window.innerWidth - 300)),
          }}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
        >
          <div className="hovercard__word">
            {hover.word}
            {hoveredSenses[0]?.inputReading && (
              <em className="result__reading">{hoveredSenses[0].inputReading}</em>
            )}
          </div>
          <ul className="hovercard__senses">
            {hoveredSenses.map((s) => {
              const isSaved = saved.has(s.wordId);
              const isBusy = saving.has(s.wordId);
              return (
                <li key={s.wordId} className="sense">
                  <span className="sense__text">{s.translation}</span>
                  {isBusy ? (
                    <span className="sense__busy">…</span>
                  ) : isSaved ? (
                    <button
                      className="sense__saved"
                      onClick={() => onMarkUnknown(s)}
                      title="In vocabulary — click if you'd forgotten it (lowers confidence)"
                    >
                      ✓ {confidence.get(s.wordId) ?? 0}/5
                    </button>
                  ) : (
                    <button className="sense__add" onClick={() => onAdd(s)} title="Add this meaning">
                      ＋
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}
