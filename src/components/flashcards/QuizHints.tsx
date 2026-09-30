// The hints under a flashcard: "Show in context" (the sentence(s) the word came from —
// text/article quizzes only) and "Show example" (the shown sense's own example
// sentence). Both toggles sit on ONE row and they are mutually exclusive: opening one
// closes the other, so only one panel shows below the row at a time.
//
// Collapsed by default so the card stays a cold recall test, reset on every card (the
// parent keys it on the card), and every translation — which would hand over the
// answer — held back until the card is revealed.
//
// Shared by BOTH flashcard surfaces (FlashcardView + TextQuizView): a change to "the
// flashcard quiz" applies everywhere (CLAUDE.md). A hint with nothing to show renders
// no toggle — most senses have no example written, and a dead toggle on every card
// would read as broken.
//
// Plain text, not the ParagraphReader SenseExample uses on a word row: a hovercard full
// of meanings under a card you're trying to recall would answer the card for you.
import { useState } from "react";
import { highlightSegments, type WordContext } from "../../services/analyze/context";
import { useI18n } from "../../i18n";

type ExampleWord = {
  input: string;
  inputReading: string | null;
  sourceLang: string;
  example: string | null;
  exampleGloss: string | null;
  definitionSource: string | null;
};

type Span = { start: number; end: number };

/** Where the headword sits in the sentence — by its headword, else its other form
 *  (a uk word headlines as kana but may be written in kanji in the example). A miss
 *  (a conjugated form) just leaves the sentence unhighlighted. */
function headwordSpan(text: string, word: ExampleWord): Span[] {
  for (const form of [word.input, word.inputReading]) {
    if (!form) continue;
    const start = text.indexOf(form);
    if (start >= 0) return [{ start, end: start + form.length }];
  }
  return [];
}

function Highlighted({ text, spans, lang }: { text: string; spans: Span[]; lang?: string }) {
  return (
    <p className="quizctx__sentence" lang={lang}>
      {highlightSegments(text, spans).map((seg, j) =>
        seg.hit ? (
          <mark className="quizctx__hit" key={`seg-${j}`}>
            {seg.text}
          </mark>
        ) : (
          <span key={`seg-${j}`}>{seg.text}</span>
        ),
      )}
    </p>
  );
}

type Panel = "context" | "example";

export function QuizHints({
  word,
  flipped,
  context = [],
}: {
  word: ExampleWord;
  flipped: boolean;
  /** Source sentences for "Show in context"; empty → no context toggle. */
  context?: WordContext[];
}) {
  const [open, setOpen] = useState<Panel | null>(null);
  const { t } = useI18n();
  const { example } = word;
  if (!example && context.length === 0) return null;

  const toggle = (panel: Panel) => setOpen((cur) => (cur === panel ? null : panel));
  const prose = word.sourceLang.toLowerCase();

  return (
    <div className="quizctx">
      <div className="quizctx__toggles">
        {context.length > 0 && (
          <button
            type="button"
            className="quizctx__toggle"
            onClick={() => toggle("context")}
            aria-expanded={open === "context"}
          >
            {open === "context" ? "▾" : "▸"}{" "}
            {t(open === "context" ? "quiz.hideContext" : "quiz.showContext")}
          </button>
        )}
        {example && (
          <button
            type="button"
            className="quizctx__toggle"
            onClick={() => toggle("example")}
            aria-expanded={open === "example"}
          >
            {open === "example" ? "▾" : "▸"}{" "}
            {t(open === "example" ? "quiz.hideExample" : "quiz.showExample")}
          </button>
        )}
      </div>

      {open === "context" && context.length > 0 && (
        <ul className="quizctx__list">
          {context.map((c, i) => (
            <li className="quizctx__item" key={`ctx-${i}`}>
              <Highlighted text={c.text} spans={c.spans} />
              {flipped && c.gloss && <p className="quizctx__gloss">{c.gloss}</p>}
            </li>
          ))}
        </ul>
      )}

      {open === "example" && example && (
        <ul className="quizctx__list">
          <li className="quizctx__item">
            <Highlighted text={example} spans={headwordSpan(example, word)} lang={prose} />
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
