// An embedded practice deck inside a lesson (a `cards` block): tap to flip, then
// "Got it" (the card leaves the deck) or "Again" (it goes to the back). The deck is done
// when every card has been got once — drilled to completion, the way a kana row is
// actually learned.
//
// Grading is practice only: these are authored cards (あ → a), not necessarily
// dictionary senses, so nothing is written to review_log. Same visual card and corner
// layout as the flashcard quiz — but not FlashcardCard, which needs every card to BE a
// sense. Here a card is a word only when the lesson resolved it (`words[i]`): then it
// gets the quiz's ? word-info (top-left) and ＋ add-to-list (top-right), and the
// finished deck offers to add every resolved word at once. Unresolved cards (kana, a
// `lookup: false` deck) show neither.
import { useState } from "react";
import { useI18n } from "../../i18n";
import { SpeakButton } from "../common/SpeakButton";
import { WordInfoButton } from "../common/WordInfo";
import { AddToListButton } from "../translate/AddToListButton";
import type { Word } from "../../services/words/repository";
import type { List } from "../../services/lists";
import { lessonAssetUrl, pickLocalized, type CardsBlock } from "../../services/lessons";
import type { LangCode } from "../../services/language";

function deal(n: number, shuffle: boolean): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  if (shuffle)
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  return order;
}

export function LessonCards({
  block,
  language,
  explainIn,
  words,
  vocab,
}: {
  block: CardsBlock;
  /** The lesson's learning language — the language of each card's FRONT. */
  language: LangCode;
  /** The language the PROSE is shown in (the lesson page's switch). */
  explainIn: LangCode;
  /** Per card (same order as `block.cards`): its dictionary senses, or null. */
  words: (Word[] | null)[];
  /** The lesson's shared knowledge state + add actions (one per lesson page). */
  vocab: {
    saved: Set<string>;
    lists: List[];
    onAdd: (words: Word[], listId?: string) => Promise<void>;
    onCreateList: (name: string) => Promise<string>;
  };
}) {
  const { t } = useI18n();
  const total = block.cards.length;
  const [queue, setQueue] = useState<number[]>(() => deal(total, block.shuffle));
  const [flipped, setFlipped] = useState(false);

  const title = pickLocalized(block.title, explainIn);
  const current = queue.length > 0 ? block.cards[queue[0]] : null;
  // The card's word = its primary sense (what the ＋ saves, like the quiz's default).
  const currentWord = queue.length > 0 ? (words[queue[0]]?.[0] ?? null) : null;
  const currentSaved = currentWord != null && vocab.saved.has(currentWord.wordId);
  // Every resolved card's word, once each — what "add all" saves at the end.
  const deckWords = [...new Map(words.flatMap((ws) => (ws?.[0] ? [[ws[0].wordId, ws[0]] as const] : []))).values()];
  const allSaved = deckWords.length > 0 && deckWords.every((w) => vocab.saved.has(w.wordId));

  const answer = (got: boolean) => {
    setFlipped(false);
    setQueue(([head, ...rest]) => (got ? rest : [...rest, head]));
  };
  const restart = () => {
    setQueue(deal(total, block.shuffle));
    setFlipped(false);
  };

  return (
    <div className="lesson__cards">
      {title && <p className="lesson__cardstitle">{title}</p>}
      {current ? (
        <>
          <p className="lesson__cardsprogress">{t("lessons.cardsProgress", { n: queue.length, total })}</p>
          <div
            className={`flashcard lesson__card${flipped ? " flashcard--flipped" : ""}`}
            onClick={flipped ? undefined : () => setFlipped(true)}
            role={flipped ? undefined : "button"}
            tabIndex={flipped ? undefined : 0}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (!flipped && (e.key === "Enter" || e.key === " ")) setFlipped(true);
            }}
          >
            {/* The quiz card's corners: ? word-info top-left, ＋ add-to-list top-right.
                Both stop propagation so using them never flips the card. Keyed on the
                sense so the button resets when the next card is dealt. */}
            {currentWord && (
              <>
                <span className="flashcard__info" onClick={(e) => e.stopPropagation()}>
                  <WordInfoButton word={currentWord} align="left" />
                </span>
                <span className="flashcard__action" onClick={(e) => e.stopPropagation()}>
                  {/* Always ＋, never a resting ✓: the button's own brief ✓ flash
                      confirms a save, and on a saved word ＋ opens the list menu
                      (alreadyAdded) — so it stays an add control, not a status mark. */}
                  <AddToListButton
                    key={currentWord.wordId}
                    className="card-add"
                    words={[currentWord]}
                    lists={vocab.lists}
                    label="＋"
                    alreadyAdded={currentSaved}
                    onAdd={vocab.onAdd}
                    onCreateList={vocab.onCreateList}
                  />
                </span>
              </>
            )}
            <span className="flashcard__speak" onClick={(e) => e.stopPropagation()}>
              <SpeakButton className="card-tool" text={current.front} lang={language} size={18} />
            </span>
            {current.image && (
              <img
                className="lesson__cardimage"
                src={lessonAssetUrl(language, current.image.src)}
                alt={pickLocalized(current.image.alt, explainIn)}
              />
            )}
            <div className="flashcard__term" lang={language.toLowerCase()}>
              {current.front}
            </div>
            {flipped ? (
              <div className="flashcard__back">
                <div className="flashcard__translation">{current.back}</div>
                {pickLocalized(current.note, explainIn) && (
                  <div className="lesson__cardnote">{pickLocalized(current.note, explainIn)}</div>
                )}
              </div>
            ) : (
              <p className="lesson__cardhint">{t("lessons.tapToReveal")}</p>
            )}
          </div>
          {flipped && (
            <div className="lesson__cardactions">
              <button type="button" className="btn btn--ghost" onClick={() => answer(false)}>
                {t("lessons.again")}
              </button>
              <button type="button" className="btn" onClick={() => answer(true)}>
                {t("lessons.gotIt")}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="lesson__cardsdone">
          <p>{t("lessons.deckDone", { total })}</p>
          {deckWords.length > 0 && (
            <AddToListButton
              className="btn"
              words={deckWords}
              lists={vocab.lists}
              // Stays "＋ Add N words" after adding — the ✓ only flashes (see the card's ＋).
              label={t("lessons.addAllWords", { n: deckWords.length })}
              alreadyAdded={allSaved}
              onAdd={vocab.onAdd}
              onCreateList={vocab.onCreateList}
            />
          )}
          <button type="button" className="btn btn--ghost" onClick={restart}>
            {t("lessons.practiceAgain")}
          </button>
        </div>
      )}
    </div>
  );
}
