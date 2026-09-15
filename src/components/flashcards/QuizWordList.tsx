// The done screen's recap: every word the session just showed, under the Retry /
// New quiz buttons, drawn as Lists rows — headword with its reading in colour, the "?"
// word info, the confidence dots (which are the "Forgot" control, as everywhere else),
// the meanings one per line, and the speak button. Shared by BOTH flashcard quiz
// components (FlashcardView and TextQuizView) — a change to "the flashcard quiz"
// applies to every surface. The Lists-only actions (edit, tag, delete) stay in Lists.
import { useState } from "react";
import { useI18n } from "../../i18n";
import { ConfidenceDots } from "../common/ConfidenceDots";
import { SpeakButton } from "../common/SpeakButton";
import { WordInfoButton } from "../common/WordInfo";
import { pronounceableText } from "../../services/voice";
import type { CardFace } from "./FlashcardCard";
import "../lists/lists.css";
import "./flashcards.css";

export interface QuizWordItem {
  key: string;
  word: CardFace;
  /** The saved word behind the card — null when it never reached the vocabulary, which
   *  leaves its dots as a plain readout (there is nothing to lower). */
  userWordId: string | null;
  /** Displayed confidence after this session's grade. */
  confidence: number;
}

export function QuizWordList({
  items,
  onForgot,
}: {
  items: QuizWordItem[];
  /** Lower a saved word one confidence bucket; resolves with its new confidence. */
  onForgot?: (item: QuizWordItem) => Promise<number>;
}) {
  const { t } = useI18n();
  // Confidence after a "Forgot" pressed on THIS screen, over the session's own value.
  const [softened, setSoftened] = useState<ReadonlyMap<string, number>>(new Map());
  if (items.length === 0) return null;

  return (
    <ul className="listrows quizwords" aria-label={t("quiz.wordsTitle")}>
      {items.map((item) => {
        const { word } = item;
        const confidence = softened.get(item.key) ?? item.confidence;
        // One meaning per line, as in Lists — never the raw "cat; feline; puss" run.
        const meanings = word.translation
          .split(";")
          .map((m) => m.trim())
          .filter(Boolean);
        const forgot =
          onForgot && item.userWordId
            ? async () => {
                const next = await onForgot(item);
                setSoftened((m) => new Map(m).set(item.key, next));
              }
            : undefined;

        return (
          <li className="listrow" key={item.key}>
            <div className="listrow__header">
              <span className="listrow__head">
                {word.input}
                {word.inputReading && <em className="listrow__reading">{word.inputReading}</em>}
              </span>
              <div className="listrow__meta">
                <WordInfoButton word={word} />
                <ConfidenceDots rating={confidence} onForgot={forgot} />
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
      })}
    </ul>
  );
}
