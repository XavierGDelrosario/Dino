// Single-word lookup results: the primary sense prominently, then up to
// DEFAULT_SHOWN total, with a "show more" revealing up to MAX_SENSES. Anything past
// MAX_SENSES is dropped — the EN→JA gloss-search tail is noisy (acronym/mid-gloss
// matches; see docs/TODO.md), so capping trades a long noisy list for a tidy one.
// Each sense renders via the shared <SenseText>; this only owns the row + add button.
//
// This is the deliberate exception to the shared list row (common/WordRow): it lists
// the SENSES of one searched term, primary first, rather than a list of saved words.
import { useState } from "react";
import type { Word } from "../../services/words/repository";
import type { List } from "../../services/lists";
import { SenseText, MAX_SENSES } from "../common/SenseText";
import { SenseExample } from "../common/SenseExample";
import { ConfidenceDots } from "../common/ConfidenceDots";
import { AddToListButton } from "./AddToListButton";
import { useI18n } from "../../i18n";
import "./translate.css";
import { WordInfoButton } from "../common/WordInfo";

const DEFAULT_SHOWN = 8; // meanings visible before "show more" (incl. the primary)

export function WordResults({
  headword,
  meanings,
  saved,
  confidence,
  lists,
  userId,
  onAdd,
  onCreateList,
  onForgot,
}: {
  headword: string;
  meanings: Word[];
  saved: Set<string>;
  confidence: Map<string, number>;
  lists: List[];
  /** Enables the knowledge-coloured reader inside an example sentence (SenseExample). */
  userId: string;
  onAdd: (words: Word[], listId?: string) => Promise<void>;
  onCreateList: (name: string) => Promise<string>;
  /** "Forgot": drop this sense one confidence bucket. Wired to the dots below, the
   *  same control Lists and the article word table use. Omit and they stay inert. */
  onForgot?: (words: Word[]) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();

  if (meanings.length === 0) {
    return (
      <div className="results results--empty">
        <p>{t("results.noTranslation")}</p>
        <p className="results__echo">{headword}</p>
      </div>
    );
  }

  const [primary, ...rest] = meanings;
  const others = rest.slice(0, MAX_SENSES - 1); // drop the noisy tail past MAX_SENSES
  const visibleOthers = expanded ? others : others.slice(0, DEFAULT_SHOWN - 1);
  const hiddenCount = others.length - (DEFAULT_SHOWN - 1); // revealed by "show more"
  const row = (word: Word, isPrimary = false) => (
    <div className={`result${isPrimary ? " result--primary" : ""}`} key={word.wordId}>
      {/* `headword` is what the user searched: a uk entry found BY ITS KANJI
          headlines as that kanji rather than flipping to kana (displayHeadword). */}
      <SenseText word={word} primary={isPrimary} query={headword} />
      {/* Level · Commonness · Part of speech — the same "?" panel as Lists, the
          flashcards and the article table. On the head row only: a word's level is its
          headword's, so repeating it per sense would say the same thing N times. */}
      {isPrimary && <WordInfoButton word={word} />}
      {/* Confidence, shown ONLY for senses actually in vocab — and as the shared DOTS,
          which are also the "Forgot" control (press → a "Forgot?" overlay). This was a
          plain "✓ n/5", the one saved-word readout in the app that was still text: the
          same word offered a way to say "I don't actually know this" in Lists, in the
          article table and in the reader's hovercard, but not in the lookup you were
          most likely looking at when you realised it. The ✓ is not lost — the add
          button beside it already says the sense is saved. */}
      {saved.has(word.wordId) && (
        <ConfidenceDots
          rating={confidence.get(word.wordId) ?? 0}
          // Per SENSE here, not per word: this row IS one sense and shows that sense's
          // own confidence, so the control has to act on what it reads. (The reader's
          // hovercard is headed by the WORD and softens all of its senses.)
          onForgot={onForgot && (() => onForgot([word]))}
        />
      )}
      {/* "Tell me more about this sense" — grouped with the confidence readout rather
          than with the add button, the same split Lists makes between information and
          actions. Renders NOTHING unless the sense actually carries an example or a
          definition, so most rows are unchanged. For EN→JA that definition is the
          English one WordNet supplies per synset (20260764), which is what separates
          spring→春 from spring→ばね at the point of choosing. */}
      <SenseExample
        example={word.example}
        exampleGloss={word.exampleGloss}
        definitionSource={word.definitionSource}
        userId={userId}
        sourceLang={word.sourceLang}
        targetLang={word.targetLang}
      />
      <AddToListButton
        words={[word]}
        lists={lists}
        label={t("translate.addBtn")}
        alreadyAdded={saved.has(word.wordId)}
        onAdd={onAdd}
        onCreateList={onCreateList}
        className="add"
      />
    </div>
  );

  return (
    <div className="results">
      {row(primary, true)}
      {visibleOthers.length > 0 && (
        <ul className="results__others">{visibleOthers.map((w) => row(w))}</ul>
      )}
      {hiddenCount > 0 && (
        <button
          className="results__more"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? t("results.showLess") : t("results.showMore", { n: hiddenCount })}
        </button>
      )}
    </div>
  );
}
