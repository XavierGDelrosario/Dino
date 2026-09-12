// Presentational sentence reader. Words are colored by knowledge (grey = no entry ·
// accent = addable · red→green by confidence once saved). HOVER lists EVERY sense with
// its own add button, so a homograph (辛い → からい / つらい) can be added by the exact
// meaning; saved senses show confidence (✓ n/5), and a word the app claims you know
// carries a top-right "Forgot" that drops it one bucket. State lives in the parent
// (useTranslate).
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { displayHeadword, isContentPos, type AnalyzedToken } from "../../services/language";
import { ReportFlagButton } from "../common/ReportFlagButton";
import type { Word } from "../../services/words/repository";
import type { List } from "../../services/lists";
import { wordKey, type SentenceGloss } from "../../services/lookup";
import { canSoften } from "../../services/review";
import { AddToListButton } from "./AddToListButton";
import { AnalyzeInfographic } from "../common/AnalyzeInfographic";
import { summarizeReader } from "../../services/analyze/summarize";
import { useI18n } from "../../i18n";
import "./translate.css";
import "../common/SenseText.css"; // shared .sense* row/action styles

// Only offer the Summary infographic once the text is long enough for the
// distributions to be meaningful (short outputs read fine as-is).
const SUMMARY_MIN_WORDS = 12;

// How long "Forgot" stays visibly spent after a press. Longer than the server's own 2s
// dedupe window (20260766) on purpose: the guard the USER experiences should be the one
// they can see, and by the time the button re-arms the new ✓ n/5 has been on screen for
// well over a second. Raise it and a deliberate second notch feels blocked; drop it below
// the server window and a legitimate press gets silently swallowed.
const FORGET_HOLD_MS = 2500;

// The marks that can BE a per-sentence control. Deliberately NOT `splitSentences`' full
// set: ASCII "." is also a decimal point, and a button mid-number reads as a typo.
// The marks that can BE a per-sentence control — the SAME set `splitSentences` ends a
// sentence on, ASCII "." INCLUDED.
//
// "." was excluded at first because it is also a decimal point, and turning one into a
// button mid-number reads as a typo. That reasoning broke ENGLISH outright: every
// English sentence ends in ".", so no line ever looked punctuated, none got its own
// translate control, and the whole text fell through to the block gloss meant for
// UNPUNCTUATED input (dictation, headlines).
//
// No digit guard is needed here even though `splitSentences` has one. Both regexes are
// only ever tested AT a sentence boundary — `gap` looks at the character a sentence ENDS
// on, ENDS_TERMINATED at the end of a sentence own text — and those boundaries were
// chosen by `splitSentences`, which already refused to split between digits. A "." that
// reaches here is a real terminator by construction; 3.14 never arrives as a boundary.
const TERMINATOR = /[。．.！？!?…]/u;
// The same, anchored, allowing closers that belong to the sentence (「…だ。」).
const ENDS_TERMINATED = /[。．.！？!?…][」』）〉》】)"'”’]*$/u;

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
  onForgot,
}: {
  text: string;
  tokens: AnalyzedToken[];
  meaningsByWord: Map<string, Word[]>;
  /** Per-sentence glosses (one per sentence, index-aligned by construction).
   *  Empty when the gloss was skipped — the reader then renders text-only. */
  sentences?: SentenceGloss[];
  /** Fetch the sentence gloss on demand (the PAID call). When given, the toggle is
   *  offered before any translation exists and buys it on first press, so a reader
   *  who never asks for English never spends. */
  onLoadGloss?: () => void | Promise<void>;
  /** Buy the English for ONE sentence. Wired to that sentence's closing punctuation —
   *  the 。 is the affordance — so a reader can pay for the one line they missed. */
  onTranslateSentence?: (index: number) => void | Promise<void>;
  glossLoading?: boolean;
  /** Start with the English showing. Set when this reader is the ANSWER to a "Show
   *  translation" press on the reader it replaced, which would otherwise come up
   *  hiding the gloss it just paid for. */
  openGloss?: boolean;
  saved: Set<string>;
  confidence: Map<string, number>;
  lists: List[];
  /** Add/tag a sense to ALL (no listId) or into a sub-list (idempotent). */
  onAdd: (words: Word[], listId?: string) => Promise<void>;
  onCreateList: (name: string) => Promise<string>;
  /** "Forgot": lower each given sense by one confidence bucket. Omit to hide the
   *  affordance entirely (a surface with no user-word ids can't act on it). */
  onForgot?: (words: Word[]) => Promise<void>;
}) {
  const { t: tr } = useI18n();
  // `key` is the token's wordKey, carried so the card looks its senses up exactly as
  // the inline word did — a capitalised or inflected surface would otherwise hover empty.
  const [hover, setHover] = useState<
    { word: string; key: string; reading: string | null; rect: DOMRect } | null
  >(null);
  // Inline translation: OFF by default — the reader is for reading the Japanese.
  // Toggling it prints each sentence's English directly beneath it, so the eye never
  // leaves the line it's reading.
  const [showGloss, setShowGloss] = useState(openGloss);
  // Sentences whose own control was pressed; the toggle above is the same thing for
  // every sentence at once.
  const [tapped, setTapped] = useState<ReadonlySet<number>>(new Set());

  // Which of the two gloss layouts the reader uses. The inline one needs a mark to hang
  // the control on, and text with no punctuation anywhere (dictated speech, a headline)
  // has none — a stand-in dot would be an invisible control sitting where the source has
  // nothing. That text gets the SIMPLE layout: one "Show translation", one block below.
  // Buying is unchanged either way; only where the answer is drawn differs.
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

  // Summary infographic, hidden by default. Recomputes when a word is added or reviewed
  // so the charts stay live.
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
  // Stable handlers, so memoizing the token spans below isn't invalidated by hover.
  // `reading` is the TOKEN's reading — the right furigana for THIS occurrence of a
  // homograph (君 → きみ here), not an arbitrary sense's reading.
  const show = useCallback(
    (word: string, key: string, reading: string | null, el: HTMLElement) => {
      clearTimeout(hideTimer.current);
      anchorEl.current = el;
      setHover({ word, key, reading, rect: el.getBoundingClientRect() });
    },
    [],
  );
  const scheduleHide = useCallback(() => {
    hideTimer.current = setTimeout(() => setHover(null), 120);
  }, []);
  const cancelHide = useCallback(() => clearTimeout(hideTimer.current), []);

  // The card is position:fixed (to escape the reader's overflow), so on its own it
  // floats in place while the page scrolls and the word slides out from under it.
  // Re-measuring the anchor on scroll/resize keeps it glued to its word. Keyed on
  // open/closed, not the rect, so it subscribes once per open; `true` capture catches
  // scrolling in any ancestor.
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

  // The colored token spans, memoized on the data that affects them so HOVERING doesn't
  // rebuild every span — a long paragraph is hundreds of tokens, and this is the
  // reader's main source of jank.
  //
  // Built per RANGE so the same code serves both layouts: the whole text as one
  // paragraph, or one range per sentence. The ranges come from the gloss's own offsets,
  // so a rendered sentence and the English under it are the same span by construction.
  const spans = useCallback(
    (from: number, to: number, key: string): JSX.Element[] => {
      const classFor = (token: AnalyzedToken): { cls: string; interactive: boolean } => {
        const senses = isContentPos(token.pos) ? meaningsByWord.get(wordKey(token)) ?? [] : [];
        if (senses.length === 0) return { cls: "tok tok--plain", interactive: false };
        const savedSenses = senses.filter((s) => saved.has(s.wordId));
        if (savedSenses.length === 0) return { cls: "tok tok--new", interactive: true };
        const best = Math.max(...savedSenses.map((s) => confidence.get(s.wordId) ?? 0));
        return { cls: `tok tok--known tok--c${best}`, interactive: true };
      };
      // The terminator ENDING a sentence becomes that sentence's translate button. It
      // reads as punctuation until hovered, so the reader gains an action but no chrome.
      const buySentence = onTranslateSentence;
      // Pressing the same control again hides the English, so whatever asked the
      // question also puts the answer away.
      const openFor = (idx: number) => () => {
        setTapped((prev) => {
          const next = new Set(prev);
          if (!next.delete(idx)) next.add(idx);
          return next;
        });
        void buySentence?.(idx);
      };
      // The text between tokens carries the sentence boundaries. A gap can SPAN a
      // boundary (the sentence ended mid-gap, on characters kuromoji didn't tokenize),
      // so it is split at each end — emitting the control after the whole gap put it
      // past the line break, next to the FOLLOWING sentence.
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
          // ONLY an actual terminator becomes the control: a sentence ending on
          // ordinary text gets nothing, since a stand-in marker is a pressable thing
          // with no glyph in the source and is unfindable. Unpunctuated text is served
          // by the whole-text block instead (see `inlineGloss`).
          parts.push(<span key={`${key}-txt-${idx}`}>{isTerminator ? chunk.slice(0, -1) : chunk}</span>);
          if (isTerminator) {
            parts.push(
              buySentence ? (
                <button
                  key={`${key}-mark-${idx}`}
                  type="button"
                  className={`reader__punct${sentences[idx]?.gloss ? " is-bought" : ""}`}
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
            onMouseEnter={interactive ? (e) => show(t.text, wordKey(t), t.reading, e.currentTarget) : undefined}
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

  // The paragraph flows as one block, EXCEPT that a sentence showing its English is
  // lifted onto its own line together with it. That fixes the alignment with no
  // measurement: a sentence starting mid-line put its translation under whatever
  // happened to be to the left, reading as if it belonged to the wrong text. Sentences
  // with nothing showing keep flowing, so the paragraph isn't chopped into rows.
  const flat = useMemo(() => {
    if (sentences.length === 0) return spans(0, text.length, "all");
    const out: JSX.Element[] = [];
    let cursor = 0;
    sentences.forEach((s, i) => {
      // Whatever sits between sentences stays in the flow rather than being absorbed
      // into either neighbour.
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
      // Turning it OFF clears individually-tapped lines too — they're the same answer
      // by another route, and leaving them on screen makes the toggle look broken.
      if (v) setTapped(new Set());
      return !v;
    });
  };

  // Cap at 12 senses (matches WordResults' MAX_SHOWN). The hovercard is transient, so
  // there's no "show more" — just trim the noisy tail.
  const hoveredSenses = (hover ? meaningsByWord.get(hover.key) ?? [] : []).slice(0, 12);

  // ── "Forgot" (top-right of the card) ────────────────────────────────────────
  // Offered only for senses the app currently claims you know: below
  // the soften floor (see canSoften) there is nothing left to soften, and a button
  // that silently does nothing is worse than no button. Acts on the WORD — every saved sense of it
  // that is still above the floor — because that is what the card is headed by.
  const forgettable =
    onForgot && hover
      ? hoveredSenses.filter((s) => saved.has(s.wordId) && canSoften(confidence.get(s.wordId)))
      : [];
  // idle → pending → done → (FORGET_HOLD_MS later) idle. The `done` hold IS the
  // client-side double-tap defence: the press has landed, the new ✓ n/5 is already on
  // screen, and the button stays visibly spent long enough to be read before it will
  // accept another press. The server refuses a second drop inside its own 2s window
  // regardless (20260766) — the hold is what makes that refusal never need to happen.
  const [forgetState, setForgetState] = useState<"idle" | "pending" | "done">("idle");
  const forgetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // ‼️ The latch is a REF, not the state above, and `disabled` is not the guard either.
  // Both are applied on the next render, and the two halves of a double-tap arrive in
  // the SAME one — so a state check reads "idle" twice and fires twice (pinned in
  // tests/components/translate/ParagraphReader.forgot.test.tsx). A ref flips
  // synchronously inside the first handler, which is the only thing the second handler
  // is guaranteed to see.
  const forgetBusy = useRef(false);
  // A new word is a new question, so the next card is never born spent. The cleanup
  // also runs on unmount, which is what stops the timer outliving the reader.
  useEffect(() => {
    setForgetState("idle");
    forgetBusy.current = false;
    return () => clearTimeout(forgetTimer.current);
  }, [hover?.key]);

  const pressForgot = async () => {
    if (!onForgot || forgetBusy.current || forgettable.length === 0) return;
    forgetBusy.current = true;
    setForgetState("pending");
    try {
      await onForgot(forgettable);
      setForgetState("done");
      forgetTimer.current = setTimeout(() => {
        forgetBusy.current = false;
        setForgetState("idle");
      }, FORGET_HOLD_MS);
    } catch {
      // The owning hook surfaces the error; here just re-arm so it can be retried.
      forgetBusy.current = false;
      setForgetState("idle");
    }
  };

  // Place the card below the word, flipping above when there's more room there, and cap
  // its height to the space available on the chosen side (with a floor, so it's never a
  // sliver) — otherwise a long sense list runs off the bottom with no way to reach it.
  const GAP = 6;
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
          {/* One switch for the whole reader: source-only ⇄ per-sentence translation. */}
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
      {/* ONE flowing paragraph, always: translations are injected under the sentence
          they belong to (see `gap`), so only glossed lines break. */}
      <p className="reader">{flat}</p>
      {/* Unpunctuated text has nowhere to put a per-sentence English, so it all goes
          here in one block. */}
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
          {/* TOP-RIGHT cluster — the two controls whose subject is the WORD rather
              than one sense, so they belong beside the headword rather than under the
              senses list, which is scrollable and can carry anything below it away.
              The flag reports the hovered word and, when it has exactly one sense, that
              sense's id; with several the user has not told us WHICH is wrong, so the
              report carries the headword alone rather than guessing. */}
          <span className="hovercard__actions">
            {/* "Forgot": one notch down for a word the colouring claims you know.
                Appears only when there is something to lower, so it is absent rather
                than disabled on a word you have just met. */}
            {forgettable.length > 0 && (
              <button
                type="button"
                className={`hovercard__forgot${forgetState === "done" ? " is-done" : ""}`}
                onClick={pressForgot}
                disabled={forgetState !== "idle"}
                aria-label={tr("reader.forgotAria")}
                title={tr("reader.forgotAria")}
              >
                {forgetState === "done" ? tr("reader.forgotDone") : tr("reader.forgot")}
              </button>
            )}
            <span className="hovercard__flag">
              <ReportFlagButton
                input={hover.word}
                wordId={hoveredSenses.length === 1 ? hoveredSenses[0].wordId : null}
                size={14}
              />
            </span>
          </span>
          <div className="hovercard__word">
            {hover.word}
            {/* THIS occurrence's context reading (君 reads きみ here), else sense 0's —
                resolved against the surface, so a uk sense reached by its KANJI shows
                the kana rather than annotating 概ね with 概ね (displayHeadword). */}
            {(hover.reading ?? (hoveredSenses[0] && displayHeadword(hoveredSenses[0], hover.word).reading)) && (
              <em className="result__reading">
                {hover.reading ?? displayHeadword(hoveredSenses[0], hover.word).reading}
              </em>
            )}
          </div>
          <ul className="hovercard__senses">
            {hoveredSenses.map((s) => (
              <li key={s.wordId} className="sense">
                <span className="sense__text">
                  {/* Per-sense reading, so a homograph's senses are distinguishable
                      (きみ "you" vs くん "Mr") when picking which to add. */}
                  {displayHeadword(s, hover.word).reading && (
                    <em className="sense__reading">{displayHeadword(s, hover.word).reading} </em>
                  )}
                  {s.translation}
                  {saved.has(s.wordId) && (
                    <em className="sense__conf"> ✓ {confidence.get(s.wordId) ?? 0}/5</em>
                  )}
                </span>
                {/* Already-saved senses start armed, so a click files them into a list. */}
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

// memo: TranslateView re-renders on every keystroke, but the reader's props (the LAST
// result) don't change while typing — so this skips re-rendering until one lands.
export const ParagraphReader = memo(ParagraphReaderImpl);
