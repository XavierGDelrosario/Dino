// Presentational sentence reader. Each word is colored by knowledge (grey = not
// in dictionary · blue = addable · red→green by confidence once in vocab). HOVER
// a word for a popover listing EVERY sense, each with its own add button — so a
// homograph (辛い → からい / つらい) lets you add the exact meaning you want, not
// just the primary. Already-saved senses show their confidence + a "don't know"
// (a review lapse). All state lives in the parent (useTranslate).
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isContentPos, type AnalyzedToken } from "../../services/language";
import type { Word } from "../../services/words/repository";
import type { List } from "../../services/lists";
import type { SentenceGloss } from "../../services/lookup";
import { AddToListButton } from "./AddToListButton";
import { AnalyzeInfographic } from "../common/AnalyzeInfographic";
import { summarizeReader } from "../../services/analyze/summarize";
import { useI18n } from "../../i18n";
import "./translate.css";
import "../common/SenseText.css"; // shared .sense* row/action styles

// Only offer the Summary infographic once the text is long enough for the
// distributions to be meaningful (short outputs read fine as-is).
const SUMMARY_MIN_WORDS = 12;

function ParagraphReaderImpl({
  text,
  tokens,
  meaningsByWord,
  sentences = [],
  onLoadGloss,
  glossLoading = false,
  saved,
  confidence,
  lists,
  onAdd,
  onCreateList,
}: {
  text: string;
  tokens: AnalyzedToken[];
  meaningsByWord: Map<string, Word[]>;
  /** Per-sentence glosses (one per sentence, index-aligned by construction).
   *  Empty when the gloss was skipped — the reader then renders text-only. */
  sentences?: SentenceGloss[];
  /** Fetch the sentence gloss on demand (the PAID call). When given, the toggle
   *  is offered even before any translation exists and buys it on first press —
   *  so a reader who never asks for English never spends. */
  onLoadGloss?: () => void | Promise<void>;
  glossLoading?: boolean;
  saved: Set<string>;
  confidence: Map<string, number>;
  lists: List[];
  /** Add/tag a sense to ALL (no listId) or into a sub-list (idempotent). */
  onAdd: (words: Word[], listId?: string) => Promise<void>;
  onCreateList: (name: string) => Promise<string>;
}) {
  const { t: tr } = useI18n();
  const [hover, setHover] = useState<{ word: string; reading: string | null; rect: DOMRect } | null>(null);
  // Inline translation: OFF by default (the reader is for reading the Japanese).
  // Toggling it on breaks the paragraph into sentences and prints each one's
  // English directly beneath it, so the eye never leaves the line it's reading.
  const [showGloss, setShowGloss] = useState(false);
  // Summary infographic (level / frequency / confidence + coverage donut), hidden
  // by default and shown above the paragraph. Recomputes when a word is added or
  // reviewed (saved/confidence change) so the charts stay live.
  const [showSummary, setShowSummary] = useState(false);
  const summary = useMemo(
    () => summarizeReader({ tokens, meaningsByWord, saved, confidence }),
    [tokens, meaningsByWord, saved, confidence],
  );
  const canSummarize = summary.total >= SUMMARY_MIN_WORDS;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The word element the card is anchored to — kept so we can re-measure it while
  // the page scrolls/resizes (below), keeping the card glued to its word.
  const anchorEl = useRef<HTMLElement | null>(null);
  // Stable handlers so memoizing the token spans below isn't invalidated by hover.
  // `reading` is the TOKEN's reading (kuromoji's context-disambiguated guess, or the
  // dictionary reading when unambiguous) — the right furigana for THIS occurrence of
  // a homograph (君 → きみ here), not an arbitrary sense's reading.
  const show = useCallback((word: string, reading: string | null, el: HTMLElement) => {
    clearTimeout(hideTimer.current);
    anchorEl.current = el;
    setHover({ word, reading, rect: el.getBoundingClientRect() });
  }, []);
  const scheduleHide = useCallback(() => {
    hideTimer.current = setTimeout(() => setHover(null), 120);
  }, []);
  const cancelHide = useCallback(() => clearTimeout(hideTimer.current), []);

  // The card is position:fixed (so it can escape the reader's overflow), which by
  // itself leaves it floating in place on the screen while the page scrolls — the
  // word slides out from under it. Re-measure the anchor word on scroll/resize so
  // the card STAYS on its word (scrolls away with the text) instead of drifting.
  // Keyed on open/closed only (not the rect) so it subscribes once per open, not
  // once per reposition. `true` capture catches scrolling in any ancestor too.
  const isOpen = hover !== null;
  useEffect(() => {
    if (!isOpen) return;
    const reposition = () => {
      const el = anchorEl.current;
      if (el) setHover((h) => (h ? { ...h, rect: el.getBoundingClientRect() } : h));
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [isOpen]);

  // The colored token spans. Memoized on the data that affects them (text/tokens +
  // knowledge state), so HOVERING — which only changes `hover` — no longer rebuilds
  // every span. A long paragraph is hundreds of tokens; this is the reader's main
  // source of jank. Knowledge class: grey (grammatical / no entry) · blue (addable) ·
  // red→green by the confidence of the best-known sense.
  //
  // Built per RANGE so the same code serves both layouts: the whole text as one
  // paragraph (gloss off) or one range per sentence (gloss on). The ranges come
  // from the gloss's own offsets, so a rendered sentence and the English under
  // it are the same span of text by construction.
  const spans = useCallback(
    (from: number, to: number, key: string): JSX.Element[] => {
      const classFor = (token: AnalyzedToken): { cls: string; interactive: boolean } => {
        const senses = isContentPos(token.pos) ? meaningsByWord.get(token.text) ?? [] : [];
        if (senses.length === 0) return { cls: "tok tok--plain", interactive: false };
        const savedSenses = senses.filter((s) => saved.has(s.wordId));
        if (savedSenses.length === 0) return { cls: "tok tok--new", interactive: true };
        const best = Math.max(...savedSenses.map((s) => confidence.get(s.wordId) ?? 0));
        return { cls: `tok tok--known tok--c${best}`, interactive: true };
      };
      const out: JSX.Element[] = [];
      let cursor = from;
      tokens.forEach((t, i) => {
        if (t.start < from || t.end > to) return; // belongs to another sentence
        if (t.start > cursor) out.push(<span key={`${key}-gap-${i}`}>{text.slice(cursor, t.start)}</span>);
        const { cls, interactive } = classFor(t);
        out.push(
          <span
            key={`${key}-tok-${i}`}
            className={cls}
            onMouseEnter={interactive ? (e) => show(t.text, t.reading, e.currentTarget) : undefined}
            onMouseLeave={interactive ? scheduleHide : undefined}
          >
            {t.text}
          </span>
        );
        cursor = Math.max(cursor, t.end);
      });
      if (cursor < to) out.push(<span key={`${key}-gap-end`}>{text.slice(cursor, to)}</span>);
      return out;
    },
    [text, tokens, meaningsByWord, saved, confidence, show, scheduleHide],
  );

  // Gloss OFF: the whole text as one flowing paragraph — the full range, so the
  // whitespace BETWEEN sentences is kept (the per-sentence ranges skip it).
  const flat = useMemo(() => spans(0, text.length, "all"), [spans, text]);
  // Gloss ON: one range per sentence, each with the English that belongs to it.
  const blocks = useMemo(
    () => sentences.map((s, i) => ({ gloss: s.gloss, parts: spans(s.start, s.end, `s${i}`) })),
    [spans, sentences],
  );
  const hasGloss = sentences.some((s) => s.gloss);
  // Offer the toggle when there's a translation to show OR a way to fetch one.
  const canShowGloss = hasGloss || !!onLoadGloss;
  // First press buys the translation; later presses just show/hide what we hold.
  const toggleGloss = () => {
    if (!hasGloss && onLoadGloss && !glossLoading) void onLoadGloss();
    setShowGloss((v) => !v);
  };

  // Cap the hovercard at 12 senses (matches WordResults' MAX_SHOWN). The hovercard
  // is transient, so there's no "show more" — just trim the noisy tail.
  const hoveredSenses = (hover ? meaningsByWord.get(hover.word) ?? [] : []).slice(0, 12);

  // Place the card below the word, but flip above when there's more room there —
  // and cap its height to the available space so a long sense list stays on-screen
  // and scrolls internally (otherwise it ran off the bottom with no way to reach it).
  const GAP = 6;
  // Compact cap: the card never grows past MAX_H (the senses list scrolls past
  // that), and is further limited to the space available on the chosen side, with
  // a small floor so it's never a sliver.
  const MAX_H = 300;
  const placement = hover
    ? (() => {
        const below = window.innerHeight - hover.rect.bottom - GAP;
        const above = hover.rect.top - GAP;
        const flipUp = below < 220 && above > below;
        const avail = flipUp ? above : below;
        return {
          maxHeight: Math.round(Math.min(Math.max(avail, 140), MAX_H)),
          ...(flipUp
            ? { bottom: Math.round(window.innerHeight - hover.rect.top + GAP) }
            : { top: Math.round(hover.rect.bottom + GAP) }),
        };
      })()
    : null;

  return (
    <>
      {(canSummarize || canShowGloss) && (
        <div className="reader-summary">
          {canSummarize && (
            <button
              type="button"
              className="reader-summary__toggle"
              onClick={() => setShowSummary((v) => !v)}
              aria-expanded={showSummary}
            >
              {showSummary ? "▾" : "▸"} Quick summary
            </button>
          )}
          {/* One switch for the whole reader: Japanese-only ⇄ each sentence
              followed by its own translation. */}
          {canShowGloss && (
            <button
              type="button"
              className="reader-summary__toggle"
              onClick={toggleGloss}
              aria-pressed={showGloss}
              disabled={glossLoading}
            >
              {showGloss ? "▾" : "▸"}{" "}
              {glossLoading ? tr("translate.glossPending") : tr("translate.showEnglish")}
            </button>
          )}
          {canSummarize && showSummary && <AnalyzeInfographic data={summary.data} />}
        </div>
      )}
      {/* Falls back to the flowing paragraph while an on-demand gloss is still in
          flight (no sentences yet) — the Japanese never disappears. */}
      {showGloss && blocks.length > 0 ? (
        <div className="reader reader--glossed">
          {blocks.map((b, i) => (
            <p className="reader__pair" key={`pair-${i}`}>
              <span className="reader__source-line">{b.parts}</span>
              {/* A sentence MT couldn't translate simply shows nothing here —
                  the Japanese above it is still the real content. */}
              {b.gloss && <span className="reader__gloss">{b.gloss}</span>}
            </p>
          ))}
        </div>
      ) : (
        <p className="reader">{flat}</p>
      )}
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
