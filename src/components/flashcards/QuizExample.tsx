// "Show example" — the shown sense's own example sentence, under a flashcard. The
// sibling of "Show in context" (TextQuizView) and deliberately the same disclosure:
// collapsed by default so the card stays a cold recall test, reset on every card
// (the parent keys it on the card position), and the translation — which would hand
// over the answer — held back until the card is revealed.
//
// Shared by BOTH flashcard surfaces (FlashcardView + TextQuizView): a change to "the
// flashcard quiz" applies everywhere (CLAUDE.md). Renders NOTHING when the sense has no
// example written, the same rule SenseExample follows — most senses are unwritten, and
// a dead toggle on every card would read as broken.
//
// Plain text, not the ParagraphReader SenseExample uses on a word row: a hovercard full
// of meanings under a card you're trying to recall would answer the card for you.
import { useState } from "react";
import { highlightSegments } from "../../services/analyze/context";
import { useI18n } from "../../i18n";

type ExampleWord = {
  input: string;
  inputReading: string | null;
  sourceLang: string;
  example: string | null;
  exampleGloss: string | null;
  definitionSource: string | null;
};

/** Where the headword sits in the sentence — by its headword, else its other form
 *  (a uk word headlines as kana but may be written in kanji in the example). A miss
 *  (a conjugated form) just leaves the sentence unhighlighted. */
function headwordSpan(text: string, word: ExampleWord): { start: number; end: number }[] {
  for (const form of [word.input, word.inputReading]) {
    if (!form) continue;
    const start = text.indexOf(form);
    if (start >= 0) return [{ start, end: start + form.length }];
  }
  return [];
}

export function QuizExample({ word, flipped }: { word: ExampleWord; flipped: boolean }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const { example } = word;
  if (!example) return null;

  const prose = word.sourceLang.toLowerCase();
  return (
    <div className="quizctx">
      <button
        type="button"
        className="quizctx__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} {t(open ? "quiz.hideExample" : "quiz.showExample")}
      </button>
      {open && (
        <ul className="quizctx__list">
          <li className="quizctx__item">
            <p className="quizctx__sentence" lang={prose}>
              {highlightSegments(example, headwordSpan(example, word)).map((seg, j) =>
                seg.hit ? (
                  <mark className="quizctx__hit" key={`seg-${j}`}>
                    {seg.text}
                  </mark>
                ) : (
                  <span key={`seg-${j}`}>{seg.text}</span>
                ),
              )}
            </p>
            {/* The gloss and the definition both say what the word MEANS, so — like the
                context sentence's translation — they wait for the reveal. */}
            {flipped && word.exampleGloss && <p className="quizctx__gloss">{word.exampleGloss}</p>}
            {flipped && word.definitionSource && (
              <p className="quizctx__gloss" lang={prose}>
                {word.definitionSource}
              </p>
            )}
          </li>
        </ul>
      )}
    </div>
  );
}
