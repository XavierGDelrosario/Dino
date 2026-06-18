// Single-word lookup results: the primary sense prominently, the rest behind an
// "Other meanings" disclosure, each with an add-to-vocabulary button. Display of
// each sense is the shared <SenseText>; this only owns the row + add button.
import { useState } from "react";
import type { Word } from "../../services/words/repository";
import { SenseText } from "../common/SenseText";
import "./translate.css";

export function WordResults({
  headword,
  meanings,
  saved,
  saving,
  onSave,
}: {
  headword: string;
  meanings: Word[];
  saved: Set<string>;
  saving: Set<string>;
  onSave: (word: Word) => void;
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

  return (
    <div className="results">
      <SenseRow word={primary} primary saved={saved.has(primary.wordId)} saving={saving.has(primary.wordId)} onSave={onSave} />
      {others.length > 0 && (
        <>
          <button className="results__more" onClick={() => setShowOthers((v) => !v)} aria-expanded={showOthers}>
            {showOthers ? "Hide other meanings" : `Other meanings (${others.length})`}
          </button>
          {showOthers && (
            <ul className="results__others">
              {others.map((w) => (
                <SenseRow key={w.wordId} word={w} saved={saved.has(w.wordId)} saving={saving.has(w.wordId)} onSave={onSave} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function SenseRow({
  word,
  primary = false,
  saved,
  saving,
  onSave,
}: {
  word: Word;
  primary?: boolean;
  saved: boolean;
  saving: boolean;
  onSave: (word: Word) => void;
}) {
  return (
    <div className={`result${primary ? " result--primary" : ""}`}>
      <SenseText word={word} primary={primary} />
      <button
        className={`add${saved ? " add--done" : ""}`}
        onClick={() => onSave(word)}
        disabled={saved || saving}
        aria-label={saved ? "In your vocabulary" : "Add to vocabulary"}
      >
        {saved ? "✓ In vocab" : saving ? "…" : "+ Add"}
      </button>
    </div>
  );
}
