// The done screen's recap: every word the session just showed, under the Retry /
// New quiz buttons, drawn as Lists rows — headword with its reading in colour, the "?"
// word info, the confidence dots (which are the "Forgot" control, as everywhere else),
// the ＋ that files the word into a list (the shared ListMenu, so "New list…" works
// here too), the meanings one per line, and the speak button. Shared by BOTH flashcard
// quiz components (FlashcardView and TextQuizView) — a change to "the flashcard quiz"
// applies to every surface. Edit and delete stay in Lists.
import { useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { ConfidenceDots } from "../common/ConfidenceDots";
import { ListMenu } from "../common/ListMenu";
import { SpeakButton } from "../common/SpeakButton";
import { WordInfoButton } from "../common/WordInfo";
import { pronounceableText } from "../../services/voice";
import type { List } from "../../services/lists";
import type { CardFace } from "./FlashcardCard";
import "../lists/lists.css";
import "./flashcards.css";

export interface QuizWordItem {
  key: string;
  word: CardFace;
  /** The saved word behind the card — null when it never reached the vocabulary, which
   *  leaves its dots as a plain readout and offers no ＋ (there is nothing to file). */
  userWordId: string | null;
  /** Displayed confidence after this session's grade. */
  confidence: number;
}

interface RowActions {
  lists: List[];
  /** File a saved word into a list (idempotent). */
  onTag: (item: QuizWordItem, listId: string) => Promise<void>;
  /** Create a list, resolving with its id (the word is then filed into it). */
  onCreateList: (name: string) => Promise<string>;
  /** Lower a saved word one confidence bucket; resolves with its new confidence. */
  onForgot?: (item: QuizWordItem) => Promise<number>;
}

function QuizWordRow({
  item,
  lists,
  onTag,
  onCreateList,
  onForgot,
}: RowActions & { item: QuizWordItem }) {
  const { t } = useI18n();
  const { word } = item;
  const tagBtnRef = useRef<HTMLButtonElement>(null);
  const [tagMenu, setTagMenu] = useState(false);
  // Confidence after a "Forgot" pressed on THIS screen, over the session's own value.
  const [softened, setSoftened] = useState<number | null>(null);
  const confidence = softened ?? item.confidence;

  // One meaning per line, as in Lists — never the raw "cat; feline; puss" run.
  const meanings = word.translation
    .split(";")
    .map((m) => m.trim())
    .filter(Boolean);
  const saved = item.userWordId !== null;
  const forgot =
    onForgot && saved
      ? async () => setSoftened(await onForgot(item))
      : undefined;

  return (
    <li className="listrow">
      <div className="listrow__header">
        <span className="listrow__head">
          {word.input}
          {word.inputReading && <em className="listrow__reading">{word.inputReading}</em>}
        </span>
        <div className="listrow__meta">
          <WordInfoButton word={word} />
          <ConfidenceDots rating={confidence} onForgot={forgot} />
          {saved && (
            <>
              <button
                ref={tagBtnRef}
                type="button"
                className="iconbtn listrow__tag"
                onClick={() => setTagMenu(true)}
                aria-label={t("lists.addToList")}
                title={t("lists.addToList")}
              >
                ＋
              </button>
              {tagMenu && (
                <ListMenu
                  anchorRef={tagBtnRef}
                  lists={lists}
                  title={t("lists.addToList")}
                  onPick={(listId) => onTag(item, listId).then(() => setTagMenu(false))}
                  onCreate={(name) =>
                    onCreateList(name)
                      .then((listId) => onTag(item, listId))
                      .then(() => setTagMenu(false))
                  }
                  onClose={() => setTagMenu(false)}
                />
              )}
            </>
          )}
        </div>
      </div>
      <div className="listrow__foot">
        <div className="listrow__meaning">
          {meanings.map((m, i) => (
            <span key={i} className="listrow__meaning-line">
              {m}
              {i === 0 && word.translationReading && (
                <em className="listrow__reading">{word.translationReading}</em>
              )}
            </span>
          ))}
        </div>
        <SpeakButton text={pronounceableText(word)} lang={word.sourceLang} size={16} />
      </div>
    </li>
  );
}

export function QuizWordList({ items, ...actions }: RowActions & { items: QuizWordItem[] }) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <ul className="listrows quizwords" aria-label={t("quiz.wordsTitle")}>
      {items.map((item) => (
        <QuizWordRow key={item.key} item={item} {...actions} />
      ))}
    </ul>
  );
}
