// The done screen's recap: every word the session just showed, under the Retry /
// New quiz buttons, drawn as the shared <WordRow> a Lists row uses — headword with its
// reading in colour, the "?" word info, the confidence dots (which are the "Forgot"
// control, as everywhere else), the ＋ that files the word into a list (the shared
// TagListButton, so "New list…" works here too), the meanings one per line, and the
// speak button. Shared by BOTH flashcard
// quiz components (FlashcardView and TextQuizView) — a change to "the flashcard quiz"
// applies to every surface. Edit and delete stay in Lists.
import { useState } from "react";
import { useI18n } from "../../i18n";
import { ConfidenceDots } from "../common/ConfidenceDots";
import { TagListButton } from "../common/TagListButton";
import { WordInfoButton } from "../common/WordInfo";
import { WordRow } from "../common/WordRow";
import type { List } from "../../services/lists";
import type { CardFace } from "./FlashcardCard";
import "./flashcards.css";

export interface QuizWordItem {
  key: string;
  word: CardFace;
  /** The saved word behind the card — null when it never reached the vocabulary, which
   *  leaves its dots as a plain readout and offers no ＋ (there is nothing to file). */
  userWordId: string | null;
  /** Displayed confidence after this session's grade. */
  confidence: number;
  /** Displayed confidence BEFORE the session, so the dots can mark what it moved.
   *  Omit (or match `confidence`) and the row draws a plain readout. */
  previousConfidence?: number | null;
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
  const { word } = item;
  // Confidence after a "Forgot" pressed on THIS screen, over the session's own value.
  const [softened, setSoftened] = useState<number | null>(null);
  const confidence = softened ?? item.confidence;
  const saved = item.userWordId !== null;
  const forgot =
    onForgot && saved
      ? async () => setSoftened(await onForgot(item))
      : undefined;

  return (
    <WordRow
      word={word}
      meta={
        <>
          <WordInfoButton word={word} />
          {/* `previous` is the SESSION's starting value, so a "Forgot" pressed here
              keeps widening the same comparison instead of resetting the baseline. */}
          <ConfidenceDots
            rating={confidence}
            previous={item.previousConfidence}
            onForgot={forgot}
          />
          {saved && (
            <TagListButton
              lists={lists}
              onPick={(listId) => onTag(item, listId)}
              onCreate={(name) => onCreateList(name).then((listId) => onTag(item, listId))}
            />
          )}
        </>
      }
    />
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
