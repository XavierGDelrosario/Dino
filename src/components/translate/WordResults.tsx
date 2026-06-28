// Single-word lookup results: the primary sense prominently, then up to
// DEFAULT_SHOWN total, with a "show more" revealing up to MAX_SHOWN. Anything past
// MAX_SHOWN is dropped — the EN→JA gloss-search tail is noisy (acronym/mid-gloss
// matches; see docs/TODO.md), so capping trades a long noisy list for a tidy one.
// Each sense renders via the shared <SenseText>; this only owns the row + add button.
import { useState } from "react";

const DEFAULT_SHOWN = 8; // meanings visible before "show more" (incl. the primary)
const MAX_SHOWN = 12; // absolute ceiling, even when expanded
import type { Word } from "../../services/words/repository";
import type { List } from "../../services/lists";
import { SenseText } from "../common/SenseText";
import { AddToListButton } from "./AddToListButton";
import { useI18n } from "../../i18n";
import "./translate.css";

export function WordResults({
  headword,
  meanings,
  saved,
  confidence,
  lists,
  onAdd,
  onCreateList,
}: {
  headword: string;
  meanings: Word[];
  saved: Set<string>;
  confidence: Map<string, number>;
  lists: List[];
  onAdd: (words: Word[], listId?: string) => Promise<void>;
  onCreateList: (name: string) => Promise<string>;
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
  const others = rest.slice(0, MAX_SHOWN - 1); // drop the noisy tail past MAX_SHOWN
  const visibleOthers = expanded ? others : others.slice(0, DEFAULT_SHOWN - 1);
  const hiddenCount = others.length - (DEFAULT_SHOWN - 1); // revealed by "show more"
  const row = (word: Word, isPrimary = false) => (
    <div className={`result${isPrimary ? " result--primary" : ""}`} key={word.wordId}>
      <SenseText word={word} primary={isPrimary} />
      {/* Added + confidence indicator, shown ONLY for senses actually in vocab. */}
      {saved.has(word.wordId) && (
        <em className="sense__conf">✓ {confidence.get(word.wordId) ?? 0}/5</em>
      )}
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
