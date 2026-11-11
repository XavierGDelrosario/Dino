// One open lesson — the page a LessonsSection takes over the Learn tab with.
//
// Renders the lesson's blocks in order. Two rules carry over from the rest of the app:
//   - learning-language EXAMPLES render through ParagraphReader (furigana, knowledge
//     colouring, hover → add), never as a dead <p>. They are analysed in ONE batch via
//     useSenseExampleReader — the same engine as a sense's 例 panel — with `skipGloss`
//     and `dictionaryOnly`, so opening a lesson never bills MT;
//   - explanation prose is picked for the reader's NATIVE language (pickLocalized), so
//     the page is keyed on the pair, not on Japanese.
// A block type this build doesn't know never reaches here (parse.ts drops it).
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { ParagraphReader } from "../components/translate/ParagraphReader";
import { useSenseExampleReader } from "../hooks/useSenseExampleReader";
import { LessonCards } from "../components/lessons/LessonCards";
import { LessonChoice } from "../components/lessons/LessonChoice";
import { LangSwitch } from "../components/lessons/LangSwitch";
import { OnOffSwitch } from "../components/lessons/OnOffSwitch";
import { ErrorText } from "../components/common/ErrorText";
import { PageLoading } from "../components/common/Loading";
import {
  getLesson,
  lessonAssetUrl,
  pickLocalized,
  proseLanguages,
  type ExampleBlock,
  type Lesson,
  type LessonBlock,
  type LessonSummary,
} from "../services/lessons";
import type { LangCode } from "../services/language";
import type { Word } from "../services/words/repository";
import type { SenseExamplePart } from "../hooks/useSenseExampleReader";

const isExample = (b: LessonBlock): b is ExampleBlock => b.type === "example";

/**
 * The explanation-language switch's position, remembered per device. Stored as a SIDE
 * of the pair ("native" | "learning"), not a code, so it means the same thing for any
 * pair — "show me explanations in the language I'm learning".
 */
type ProseSide = "native" | "learning";
const SIDE_KEY = "dino.lessons.explainIn";
function readSide(): ProseSide {
  try {
    return localStorage.getItem(SIDE_KEY) === "learning" ? "learning" : "native";
  } catch {
    return "native";
  }
}
function writeSide(side: ProseSide): void {
  try {
    localStorage.setItem(SIDE_KEY, side);
  } catch {
    /* blocked storage — the switch still works for this visit */
  }
}

/** The "Reader" switch (learning-language explanations through the word reader, or as
 *  plain text). Per device; ON unless turned off. */
const READER_KEY = "dino.lessons.proseReader";
function readReaderOn(): boolean {
  try {
    return localStorage.getItem(READER_KEY) !== "off";
  } catch {
    return true;
  }
}
function writeReaderOn(on: boolean): void {
  try {
    localStorage.setItem(READER_KEY, on ? "on" : "off");
  } catch {
    /* blocked storage — the switch still works for this visit */
  }
}

/**
 * The dictionary word an analysed card resolved to: its senses when the analysis found
 * EXACTLY ONE word with meanings, else null. Two or more means the card's text split
 * into several words (a phrase, a mis-segmented kana fragment) — offering ＋ on one of
 * them would save the wrong thing, so the card simply gets no ? / ＋.
 */
function cardSenses(part: SenseExamplePart | undefined): Word[] | null {
  if (!part?.ready) return null;
  const found = [...part.meaningsByWord.values()].filter((ws) => ws.length > 0);
  return found.length === 1 ? found[0] : null;
}

/** Blank-line-separated paragraphs — the ONE split, shared by rendering and the
 *  reader's slot list so a paragraph's slot can never point at its neighbour. */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * The learning-language PROSE the reader analyses: explanation paragraphs, pattern
 * notes and image captions, each with a stable key (`block:paragraph`). Taken from the
 * learning-language entry ONLY (never a fallback), so it is exactly what the page shows
 * when the switch is on that side.
 */
function learningProse(lesson: Lesson): { key: string; text: string }[] {
  const lang = lesson.language;
  const out: { key: string; text: string }[] = [];
  lesson.blocks.forEach((b, i) => {
    if (b.type === "text" && b.body[lang]) splitParagraphs(b.body[lang]!).forEach((t, j) => out.push({ key: `${i}:${j}`, text: t }));
    if (b.type === "pattern" && b.note[lang]) out.push({ key: `${i}:0`, text: b.note[lang]! });
    if (b.type === "image" && b.caption[lang]) out.push({ key: `${i}:0`, text: b.caption[lang]! });
  });
  return out;
}

export function LessonView({
  userId,
  langs,
  summary,
  completed,
  onBack,
  onFinish,
}: {
  userId: string;
  langs: { learning: LangCode; native: LangCode };
  summary: LessonSummary;
  completed: boolean;
  onBack: () => void;
  onFinish: () => void;
}) {
  const { t } = useI18n();
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [side, setSide] = useState<ProseSide>(readSide);
  const [readerOn, setReaderOn] = useState<boolean>(readReaderOn);

  useEffect(() => {
    window.scrollTo?.(0, 0);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    getLesson(langs.learning, summary.file)
      .then((l) => !cancelled && setLesson(l))
      .catch((e) => {
        console.warn("LessonView: could not load lesson", summary.id, e);
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [langs.learning, summary.file, summary.id, attempt]);

  const language = lesson?.language ?? langs.learning;
  const native = langs.native;
  // The switch appears only when the lesson really has prose in the learning language
  // (otherwise pickLocalized falls back and flipping it would change nothing).
  const canSwitch = lesson != null && native !== language && proseLanguages(lesson).has(language);
  // Explanations follow the switch; example GLOSSES always stay in the native language.
  const explainIn = canSwitch && side === "learning" ? language : native;
  const explainingInLearning = explainIn === language;
  // The examples always use the reader; the explanations do only when the "Reader"
  // switch (shown under EN | JA while on the learning side) is on.
  const proseInReader = explainingInLearning && readerOn;

  // ONE reader over the examples AND the learning-language explanations, so they share a
  // single saved/known state: a word added from an explanation turns green in the
  // examples too. The prose joins the batch the first time the switch reaches the
  // learning language and then STAYS (sticky), because changing `texts` re-analyses the
  // whole batch — flipping back and forth must not redo the examples each time. Native
  // prose never goes through the reader: there is nothing in it to study.
  const [proseWanted, setProseWanted] = useState(false);
  useEffect(() => {
    if (proseInReader) setProseWanted(true);
  }, [proseInReader]);
  const examples = lesson?.blocks.filter(isExample) ?? [];
  // Card words ride the same batch, so a card's ＋ and the examples agree on what is
  // saved. `word` (when the author pinned one) beats the front.
  const cardTexts: { key: string; text: string }[] = [];
  lesson?.blocks.forEach((b, i) => {
    if (b.type === "cards" && b.lookup) b.cards.forEach((c, j) => cardTexts.push({ key: `${i}:${j}`, text: c.word ?? c.front }));
  });
  const prose = lesson && proseWanted ? learningProse(lesson) : [];
  const reader = useSenseExampleReader({
    userId,
    texts: [...examples.map((b) => b.text), ...cardTexts.map((c) => c.text), ...prose.map((p) => p.text)],
    sourceLang: language,
    targetLang: native,
    active: lesson != null && examples.length + cardTexts.length + prose.length > 0,
  });
  const cardSlot = new Map(cardTexts.map((c, k) => [c.key, examples.length + k]));
  const proseSlot = new Map(prose.map((p, k) => [p.key, examples.length + cardTexts.length + k]));
  const vocab = {
    saved: reader.saved,
    lists: reader.lists,
    onAdd: reader.addWords,
    onCreateList: reader.createNamedList,
  };

  /** Learning-language prose through the reader once analysed; plain text otherwise. */
  const readerText = (key: string, text: string, className?: string) => {
    const part = proseInReader ? reader.parts[proseSlot.get(key) ?? -1] : undefined;
    if (!part?.ready)
      return (
        <p key={key} className={className} lang={explainIn.toLowerCase()}>
          {text}
        </p>
      );
    return (
      <div key={key} className={`lesson__reader lesson__reader--prose${className ? ` ${className}` : ""}`}>
        <ParagraphReader
          text={text}
          tokens={part.tokens}
          meaningsByWord={part.meaningsByWord}
          saved={reader.saved}
          confidence={reader.confidence}
          lists={reader.lists}
          onAdd={reader.addWords}
          onCreateList={reader.createNamedList}
          hideSummary
        />
      </div>
    );
  };
  const title = pickLocalized(lesson?.title ?? summary.title, explainIn);
  let exampleIndex = 0;

  return (
    <article className="lesson">
      <div className="lesson__topbar">
        <button type="button" className="btn btn--ghost lesson__back" onClick={onBack}>
          {t("lessons.back")}
        </button>
        {canSwitch && (
          <div className="lesson__switches">
            <LangSwitch
              left={native}
              right={language}
              value={explainIn}
              label={t("lessons.explainIn")}
              onChange={(code) => {
                const next: ProseSide = code === language ? "learning" : "native";
                setSide(next);
                writeSide(next);
              }}
            />
            {explainingInLearning && (
              <OnOffSwitch
                label={t("lessons.reader")}
                checked={readerOn}
                onChange={(on) => {
                  setReaderOn(on);
                  writeReaderOn(on);
                }}
              />
            )}
          </div>
        )}
      </div>
      <header className="lesson__header">
        {summary.level && <span className="lesson__level">{summary.level}</span>}
        <h2 className="lesson__title">{title}</h2>
      </header>

      {error && (
        <div className="review__msg">
          <ErrorText message={t("lessons.lessonError")} />
          <button type="button" className="btn btn--ghost" onClick={() => setAttempt((n) => n + 1)}>
            {t("lessons.retry")}
          </button>
        </div>
      )}
      {/* An opened lesson replaces the tab like a page, so it gets the page loader. */}
      {!lesson && !error && <PageLoading />}

      {lesson?.blocks.map((block, i) => {
        switch (block.type) {
          case "text":
            return (
              <div key={i} className="lesson__text">
                {splitParagraphs(pickLocalized(block.body, explainIn)).map((p, j) => readerText(`${i}:${j}`, p))}
              </div>
            );
          case "pattern":
            return (
              <div key={i} className="lesson__pattern">
                <div className="lesson__patternform" lang={language.toLowerCase()}>
                  {block.pattern}
                </div>
                {pickLocalized(block.note, explainIn) &&
                  readerText(`${i}:0`, pickLocalized(block.note, explainIn), "lesson__patternnote")}
              </div>
            );
          case "example": {
            const part = reader.parts[exampleIndex++];
            const gloss = pickLocalized(block.gloss, native);
            return (
              <div key={i} className="lesson__example">
                {part?.ready ? (
                  <div className="lesson__reader">
                    <ParagraphReader
                      text={block.text}
                      tokens={part.tokens}
                      meaningsByWord={part.meaningsByWord}
                      saved={reader.saved}
                      confidence={reader.confidence}
                      lists={reader.lists}
                      onAdd={reader.addWords}
                      onCreateList={reader.createNamedList}
                      hideSummary
                    />
                  </div>
                ) : (
                  // Readable at once; colouring arrives with the analysis.
                  <p className={`lesson__sentence${reader.loading ? " is-loading" : ""}`} lang={language.toLowerCase()}>
                    {block.text}
                  </p>
                )}
                {gloss && <p className="lesson__gloss">{gloss}</p>}
              </div>
            );
          }
          case "image": {
            const caption = pickLocalized(block.caption, explainIn);
            return (
              <figure key={i} className="lesson__figure">
                <img
                  src={lessonAssetUrl(language, block.image.src)}
                  alt={pickLocalized(block.image.alt, explainIn)}
                  loading="lazy"
                />
                {caption && <figcaption>{readerText(`${i}:0`, caption, "lesson__caption")}</figcaption>}
              </figure>
            );
          }
          case "cards":
            return (
              <LessonCards
                key={i}
                block={block}
                language={language}
                explainIn={explainIn}
                words={block.cards.map((_, j) => cardSenses(reader.parts[cardSlot.get(`${i}:${j}`) ?? -1]))}
                vocab={vocab}
              />
            );
          case "choice":
            return <LessonChoice key={i} block={block} language={language} explainIn={explainIn} />;
        }
      })}

      {lesson && (
        <div className="lesson__footer">
          <button type="button" className="btn" onClick={onFinish}>
            {completed ? `✓ ${t("lessons.completed")}` : t("lessons.finish")}
          </button>
        </div>
      )}
    </article>
  );
}
