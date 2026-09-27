// The ONE word row behind every list-shaped word display — a Lists row, the article
// word table, the quiz recap. It owns the skeleton so the surfaces can't drift apart:
//
//   header: headword (+reading)                 · [meta: the caller's info/actions]
//   foot:   meanings, one per line (+reading)   · example disclosure · listen
//
// Callers supply only what genuinely differs — their `meta` cluster (Lists: edit /
// tag / delete; article: ×N + add; quiz: dots with a before/after mark) and, for the
// Lists edit mode, a `meaning` that replaces the meaning lines.
//
// The single-word lookup (translate/WordResults) is the deliberate exception: it is
// not a list of saved words but the SENSES of one searched term, primary first, so it
// renders each sense inline with the shared <SenseText>.
import type { HTMLAttributes, ReactNode } from "react";
import { SenseExample } from "./SenseExample";
import { SpeakButton } from "./SpeakButton";
import { pronounceableText } from "../../services/voice";
import type { LangCode } from "../../services/language";
import { splitMeanings } from "../../lib/meanings";
import "../lists/lists.css";

/** The word-like shape a row reads (a Word, a UserWord and a CardFace all fit). */
export interface WordRowWord {
  input: string;
  inputReading: string | null;
  translation: string;
  translationReading: string | null;
  sourceLang: LangCode;
  targetLang?: LangCode;
  example?: string | null;
  exampleGloss?: string | null;
  definitionSource?: string | null;
}

/** The meanings, one line each; the translation reading rides on the first. */
export function MeaningLines({
  translation,
  translationReading,
}: {
  translation: string;
  translationReading: string | null;
}) {
  return (
    <div className="listrow__meaning">
      {splitMeanings(translation).map((m, i) => (
        <span key={i} className="listrow__meaning-line">
          {m}
          {i === 0 && translationReading && (
            <em className="listrow__reading">{translationReading}</em>
          )}
        </span>
      ))}
    </div>
  );
}

export function WordRow({
  word,
  headword = word.input,
  reading = word.inputReading,
  meta,
  meaning,
  userId,
  className,
  ...liProps
}: {
  word: WordRowWord;
  /** Override the displayed headword (e.g. the article's lemma headword). */
  headword?: string;
  /** Override the reading shown beside the headword; null hides it. */
  reading?: string | null;
  /** The header's right-hand cluster: info, confidence, actions. */
  meta?: ReactNode;
  /** Replaces the meaning lines (the Lists row's inline edit field). */
  meaning?: ReactNode;
  /** Whose knowledge colours the example sentence's words. */
  userId?: string;
} & Omit<HTMLAttributes<HTMLLIElement>, "children">) {
  return (
    <li className={`listrow${className ? ` ${className}` : ""}`} {...liProps}>
      {/* Header: the word (+reading) and ALL the metadata/actions, so the meaning
          below gets the full row width. */}
      <div className="listrow__header">
        <span className="listrow__head">
          {headword}
          {reading && <em className="listrow__reading">{reading}</em>}
        </span>
        {meta && <div className="listrow__meta">{meta}</div>}
      </div>

      {/* Bottom strip: the meaning(s) on the left; the example disclosure and the
          speak button pinned bottom-RIGHT — "tell me more / play this", kept apart
          from the header's actions so they don't read as more things that edit the
          row. The strip wraps BOTH meaning variants, so the right side stays put
          while a meaning is being edited. */}
      <div className="listrow__foot">
        {meaning ?? (
          <MeaningLines
            translation={word.translation}
            translationReading={word.translationReading}
          />
        )}

        {/* Renders nothing until the sense has been written up. */}
        <SenseExample
          example={word.example ?? null}
          exampleGloss={word.exampleGloss ?? null}
          definitionSource={word.definitionSource ?? null}
          userId={userId}
          sourceLang={word.sourceLang}
          targetLang={word.targetLang}
        />

        {/* Read the WORD aloud — never the meaning (an English gloss in a Japanese
            voice is noise). Speaks the sense's reading where the headword is kanji,
            so a homograph gets its own pronunciation, in the row's own language. */}
        <SpeakButton text={pronounceableText(word)} lang={word.sourceLang} size={16} />
      </div>
    </li>
  );
}
