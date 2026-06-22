// Single-word lookup results: the primary sense prominently, the rest behind an
// "Other meanings" disclosure, each with an add-to-vocabulary button. Display of
// each sense is the shared <SenseText>; this only owns the row + add button.
import { useState } from "react";
import type { Word } from "../../services/words/repository";
import type { List } from "../../services/lists";
import { SenseText } from "../common/SenseText";
import { AddToListButton } from "./AddToListButton";
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
  const [showOthers, setShowOthers] = useState(false);

  if (meanings.length === 0) {
    return (
      <div className="results results--empty">
        <p>No translation found.</p>
        <p className="results__echo">{headword}</p>
      </div>
    );
  }

  const [primary, ...others] = meanings;
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
        label="+ Add"
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
      {others.length > 0 && (
        <>
          <button className="results__more" onClick={() => setShowOthers((v) => !v)} aria-expanded={showOthers}>
            {showOthers ? "Hide other meanings" : `Other meanings (${others.length})`}
          </button>
          {showOthers && <ul className="results__others">{others.map((w) => row(w))}</ul>}
        </>
      )}
    </div>
  );
}
