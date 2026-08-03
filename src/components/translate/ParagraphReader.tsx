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

// The marks that can BE a per-sentence control. Deliberately not `splitSentences`'
// full set: ASCII "." is also a decimal point and an abbreviation mark, and turning
// one into a button mid-number reads as a typo.
const TERMINATOR = /[。．！？!?…]/u;
// …and the same, anchored, allowing the closers that belong to the sentence
// (「…だ。」 ends on 」 but is still punctuated).
const ENDS_TERMINATED = /[。．！？!?…][」』）〉》】)"'”’]*$/u;

function ParagraphReaderImpl({
  text,
  tokens,
  meaningsByWord,
  sentences = [],
  onLoadGloss,
  onTranslateSentence,
  glossLoading = false,
  openGloss = false,
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
  /** Buy the English for ONE sentence, by index into `sentences`. Wired to that
   *  sentence's closing punctuation — the 。 is the affordance, so a reader can pay
   *  for the one line they didn't catch instead of the whole text. */
  onTranslateSentence?: (index: number) => void | Promise<void>;
  glossLoading?: boolean;
  /** Start with the English showing. Set when this reader is the ANSWER to a
   *  "Show translation" press — the press happened on the reader it replaced, so
   *  without this the gloss it just paid for would come up hidden. */
  openGloss?: boolean;
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
  const [showGloss, setShowGloss] = useState(openGloss);
  // Sentences whose control was pressed. Their English shows directly beneath them,
  // in the flow of the text — pressing again hides it. The toggle is the same thing
  // for every sentence at once.
  const [tapped, setTapped] = useState<ReadonlySet<number>>(new Set());

  // Does ANY sentence end on a real terminator? That decides which of the two gloss
  // layouts the whole reader uses.
  //
  // Inline (per-sentence English under each line) needs a mark to hang the control
  // on. Text with no punctuation anywhere — dictated speech, a headline, one typed
  // line — has none, and the stand-in dot this used to draw was a control the reader
  // couldn't see, sitting where the source had nothing. So that text gets the SIMPLE
  // layout instead: one "Show translation", the whole English in one block below.
  //
  // Buying is unchanged either way — the toggle still pays per sentence through
  // `onLoadGloss`, so the cost and the cache are exactly as before; only where the
  // answer is drawn differs.
  const inlineGloss = useMemo(() => sentences.some((s) => ENDS_TERMINATED.test(s.text)), [sentences]);

  const visibleGloss = useCallback(
    (index: number): string | null => {
      if (!inlineGloss) return null; // the whole-text block below owns it
      const gloss = sentences[index]?.gloss;
      if (!gloss) return null;
      return showGloss || tapped.has(index) ? gloss : null;
    },
    [sentences, showGloss, tapped, inlineGloss],
  );

  /** Every sentence's English as one paragraph — the unpunctuated-text layout. */
  const wholeGloss = useMemo(
    () =>
      sentences
        .map((s) => s.gloss)
        .filter(Boolean)
        .join(" "),
    [sentences],
  );

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
      // Punctuation between tokens is where the per-sentence translate lives: the
      // terminator that ENDS a sentence becomes a button for that sentence. It reads
      // as punctuation until you hover it, so the reader gains an action without
      // gaining any chrome.
      const buySentence = onTranslateSentence;
      // Show this sentence's English under it; pressing the same control again
      // hides it, so the control that asked the question also puts it away.
      const openFor = (idx: number) => () => {
        setTapped((prev) => {
          const next = new Set(prev);
          if (!next.delete(idx)) next.add(idx);
          return next;
        });
        void buySentence?.(idx);
      };
      // The text between tokens carries the sentence boundaries: a closing 。, a
      // line break, or nothing at all. A gap can also SPAN a boundary (the sentence
      // ended mid-gap, e.g. on characters kuromoji didn't tokenize), so it is split
      // at each end rather than rendered whole — emitting the control after the
      // whole gap put it past the line break, next to the FOLLOWING sentence.
      const gap = (raw: string, at: number, key: string): JSX.Element => {
        const parts: JSX.Element[] = [];
        let local = 0; // position within `raw`
        for (let idx = 0; idx < sentences.length; idx++) {
          const end = sentences[idx].end;
          if (end <= at || end > at + raw.length) continue; // boundary isn't in here
          const cut = end - at;
          const chunk = raw.slice(local, cut);
          const mark = chunk.slice(-1);
          const isTerminator = TERMINATOR.test(mark);
          // ONLY an actual terminator becomes the control. A sentence ending on
          // ordinary text gets nothing: the stand-in marker that used to go here was
          // a pressable thing with no glyph in the source, which is unfindable if you
          // don't already know it's there. Unpunctuated text is served by the
          // whole-text block instead (see `inlineGloss`).
          parts.push(<span key={`${key}-txt-${idx}`}>{isTerminator ? chunk.slice(0, -1) : chunk}</span>);
          if (isTerminator) {
            parts.push(
              buySentence ? (
                <button
                  key={`${key}-mark-${idx}`}
                  type="button"
                  className={`reader__punct${sentences[idx]?.gloss ? " is-bought" : ""}`}
                  // Clicking the OPEN sentence's mark closes it — the same control
                  // that asked the question dismisses the answer.
                  onClick={openFor(idx)}
                  title={tr("reader.translateSentence")}
                  aria-label={tr("reader.translateSentence")}
                >
                  {mark}
                </button>
              ) : (
                <span key={`${key}-mark-${idx}`}>{mark}</span>
              ),
            );
          }
          const gloss = visibleGloss(idx);
          if (gloss)
            parts.push(
              <span className="reader__gloss" key={`${key}-gloss-${idx}`}>
                {gloss}
              </span>,
            );
          local = cut;
        }
        if (local < raw.length) parts.push(<span key={`${key}-tail`}>{raw.slice(local)}</span>);
        return <span key={key}>{parts}</span>;
      };

      const out: JSX.Element[] = [];
      let cursor = from;
      tokens.forEach((t, i) => {
        if (t.start < from || t.end > to) return; // belongs to another sentence
        if (t.start > cursor) out.push(gap(text.slice(cursor, t.start), cursor, `${key}-gap-${i}`));
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
      if (cursor < to) out.push(gap(text.slice(cursor, to), cursor, `${key}-gap-end`));
      return out;
    },
    [text, tokens, meaningsByWord, saved, confidence, show, scheduleHide, sentences, onTranslateSentence, visibleGloss, tr],
  );

  // The paragraph flows as one block — EXCEPT that a sentence showing its English
  // is lifted onto its own line, together with that English.
  //
  // This is what fixes the alignment, and it needs no measurement: a sentence that
  // starts mid-line put its translation under whatever happened to be to the left,
  // which read as belonging to the wrong text. Given its own line, the sentence
  // starts at the block's edge and the English underneath starts at the same edge —
  // aligned by construction. Sentences with no translation showing are untouched and
  // keep flowing, so the paragraph is not chopped into rows.
  const flat = useMemo(() => {
    if (sentences.length === 0) return spans(0, text.length, "all");
    const out: JSX.Element[] = [];
    let cursor = 0;
    sentences.forEach((s, i) => {
      // Whatever sits between sentences (whitespace, stray punctuation) stays in
      // the flow rather than being absorbed into either neighbour.
      if (s.start > cursor) out.push(<span key={`between-${i}`}>{text.slice(cursor, s.start)}</span>);
      const parts = spans(s.start, s.end, `s${i}`);
      out.push(
        visibleGloss(i) ? (
          <span className="reader__sentence" key={`sent-${i}`}>
            {parts}
          </span>
        ) : (
          <span key={`sent-${i}`}>{parts}</span>
        ),
      );
      cursor = s.end;
    });
    if (cursor < text.length) out.push(<span key="tail">{text.slice(cursor)}</span>);
    return out;
  }, [spans, sentences, text, visibleGloss]);
  const hasGloss = sentences.some((s) => s.gloss);
  // Anything still unanswered? The gate used to be "no gloss at all", which meant a
  // text with ONE sentence tapped never asked for the rest — and, now that the press
  // runs the full submit, never ran it either.
  const needsGloss = sentences.length === 0 || sentences.some((s) => !s.gloss);
  // Offer the toggle when there's a translation to show OR a way to fetch one.
  const canShowGloss = hasGloss || !!onLoadGloss;
  // First press buys the translation; later presses just show/hide what we hold.
  const toggleGloss = () => {
    if (needsGloss && onLoadGloss && !glossLoading) void onLoadGloss();
    setShowGloss((v) => {
      // Turning it OFF clears the individually-tapped lines too. They are the same
      // answer arrived at a different way, so leaving them behind made the toggle
      // look broken: press it off and some English stays on screen.
      if (v) setTapped(new Set());
      return !v;
    });
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
      {/* ONE flowing paragraph, always. The text is never re-laid-out into a row per
          sentence; each translation is injected under the sentence it belongs to
          (see `gap`), so only glossed lines break and the rest keeps flowing. */}
      <p className="reader">{flat}</p>
      {/* Unpunctuated text: nowhere to put a per-sentence English, so the whole
          translation goes here in one block — the plain answer to one plain toggle. */}
      {!inlineGloss && showGloss && wholeGloss && <p className="reader__whole">{wholeGloss}</p>}
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
