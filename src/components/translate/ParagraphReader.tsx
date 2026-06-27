// Presentational sentence reader. Each word is colored by knowledge (grey = not
// in dictionary · blue = addable · red→green by confidence once in vocab). HOVER
// a word for a popover listing EVERY sense, each with its own add button — so a
// homograph (辛い → からい / つらい) lets you add the exact meaning you want, not
// just the primary. Already-saved senses show their confidence + a "don't know"
// (a review lapse). All state lives in the parent (useTranslate).
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { isContentPos, type AnalyzedToken } from "../../services/language";
import type { Word } from "../../services/words/repository";
import type { List } from "../../services/lists";
import { AddToListButton } from "./AddToListButton";
import "./translate.css";
import "../common/SenseText.css"; // shared .sense* row/action styles

function ParagraphReaderImpl({
  text,
  tokens,
  meaningsByWord,
  saved,
  confidence,
  lists,
  onAdd,
  onCreateList,
}: {
  text: string;
  tokens: AnalyzedToken[];
  meaningsByWord: Map<string, Word[]>;
  saved: Set<string>;
  confidence: Map<string, number>;
  lists: List[];
  /** Add/tag a sense to ALL (no listId) or into a sub-list (idempotent). */
  onAdd: (words: Word[], listId?: string) => Promise<void>;
  onCreateList: (name: string) => Promise<string>;
}) {
  const [hover, setHover] = useState<{ word: string; reading: string | null; rect: DOMRect } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Stable handlers so memoizing the token spans below isn't invalidated by hover.
  // `reading` is the TOKEN's reading (kuromoji's context-disambiguated guess, or the
  // dictionary reading when unambiguous) — the right furigana for THIS occurrence of
  // a homograph (君 → きみ here), not an arbitrary sense's reading.
  const show = useCallback((word: string, reading: string | null, el: HTMLElement) => {
    clearTimeout(hideTimer.current);
    setHover({ word, reading, rect: el.getBoundingClientRect() });
  }, []);
  const scheduleHide = useCallback(() => {
    hideTimer.current = setTimeout(() => setHover(null), 120);
  }, []);
  const cancelHide = useCallback(() => clearTimeout(hideTimer.current), []);

  // The colored token spans. Memoized on the data that affects them (text/tokens +
  // knowledge state), so HOVERING — which only changes `hover` — no longer rebuilds
  // every span. A long paragraph is hundreds of tokens; this is the reader's main
  // source of jank. Knowledge class: grey (grammatical / no entry) · blue (addable) ·
  // red→green by the confidence of the best-known sense.
  const parts = useMemo(() => {
    const classFor = (token: AnalyzedToken): { cls: string; interactive: boolean } => {
      const senses = isContentPos(token.pos) ? meaningsByWord.get(token.text) ?? [] : [];
      if (senses.length === 0) return { cls: "tok tok--plain", interactive: false };
      const savedSenses = senses.filter((s) => saved.has(s.wordId));
      if (savedSenses.length === 0) return { cls: "tok tok--new", interactive: true };
      const best = Math.max(...savedSenses.map((s) => confidence.get(s.wordId) ?? 0));
      return { cls: `tok tok--known tok--c${best}`, interactive: true };
    };
    const out: JSX.Element[] = [];
    let cursor = 0;
    tokens.forEach((t, i) => {
      if (t.start > cursor) out.push(<span key={`gap-${i}`}>{text.slice(cursor, t.start)}</span>);
      const { cls, interactive } = classFor(t);
      out.push(
        <span
          key={`tok-${i}`}
          className={cls}
          onMouseEnter={interactive ? (e) => show(t.text, t.reading, e.currentTarget) : undefined}
          onMouseLeave={interactive ? scheduleHide : undefined}
        >
          {t.text}
        </span>
      );
      cursor = Math.max(cursor, t.end);
    });
    if (cursor < text.length) out.push(<span key="gap-end">{text.slice(cursor)}</span>);
    return out;
  }, [text, tokens, meaningsByWord, saved, confidence, show, scheduleHide]);

  const hoveredSenses = hover ? meaningsByWord.get(hover.word) ?? [] : [];

  // Place the card below the word, but flip above when there's more room there —
  // and cap its height to the available space so a long sense list stays on-screen
  // and scrolls internally (otherwise it ran off the bottom with no way to reach it).
  const GAP = 6;
  const placement = hover
    ? (() => {
        const below = window.innerHeight - hover.rect.bottom - GAP;
        const above = hover.rect.top - GAP;
        const flipUp = below < 220 && above > below;
        return {
          maxHeight: Math.round(Math.max(flipUp ? above : below, 140)),
          ...(flipUp
            ? { bottom: Math.round(window.innerHeight - hover.rect.top + GAP) }
            : { top: Math.round(hover.rect.bottom + GAP) }),
        };
      })()
    : null;

  return (
    <>
      <p className="reader">{parts}</p>
      {hover && placement && hoveredSenses.length > 0 && (
        <div
          className="hovercard"
          style={{
            position: "fixed",
            left: Math.round(Math.min(hover.rect.left, window.innerWidth - 280)),
            ...placement,
          }}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
        >
          <div className="hovercard__word">
            {hover.word}
            {/* Reading for THIS occurrence: the token's context reading (a homograph
                like 君 reads きみ here), falling back to the first sense's reading. */}
            {(hover.reading ?? hoveredSenses[0]?.inputReading) && (
              <em className="result__reading">{hover.reading ?? hoveredSenses[0]?.inputReading}</em>
            )}
          </div>
          <ul className="hovercard__senses">
            {hoveredSenses.map((s) => (
              <li key={s.wordId} className="sense">
                <span className="sense__text">
                  {/* Per-sense reading so a homograph's senses are distinguishable
                      (きみ "you" vs くん "Mr" vs きんじ …) when picking which to add. */}
                  {s.inputReading && <em className="sense__reading">{s.inputReading} </em>}
                  {s.translation}
                  {saved.has(s.wordId) && (
                    <em className="sense__conf"> ✓ {confidence.get(s.wordId) ?? 0}/5</em>
                  )}
                </span>
                {/* Same add flow as elsewhere: ＋ → ✓ → ＋ → list menu. Already-saved
                    senses start armed so a click files them into a sub-list. */}
                <AddToListButton
                  words={[s]}
                  lists={lists}
                  label="＋"
                  alreadyAdded={saved.has(s.wordId)}
                  onAdd={onAdd}
                  onCreateList={onCreateList}
                  className="sense__add"
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

// memo: the parent (TranslateView) re-renders on every keystroke in the input, but
// the reader's props (the LAST translated result) are unchanged while typing a new
// paragraph — so this skips re-rendering entirely until a new translation lands.
export const ParagraphReader = memo(ParagraphReaderImpl);
