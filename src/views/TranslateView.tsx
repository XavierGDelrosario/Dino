// One translate surface. The user types a word OR a sentence into a single box;
// kuromoji (in the hook) decides which, so there's no manual mode toggle:
//   · single word  → all senses, save the primary (others behind a disclosure).
//   · sentence     → the word-by-word reader (hover for meanings + add).
// Submit is a BUTTON (never Enter — IME safety).
import { useState } from "react";
import { useTranslate } from "../hooks/useTranslate";
import { LangBar } from "../components/translate/LangBar";
import { ParagraphReader } from "../components/translate/ParagraphReader";
import type { Word } from "../services/words/repository";
import "../components/translate/translate.css";

export function TranslateView({ userId }: { userId: string }) {
  const t = useTranslate(userId);

  return (
    <section className="translate">
      <LangBar source={t.source} target={t.target} onSource={t.setSource} onTarget={t.setTarget} />

      <div className="translate__input">
        <textarea
          className="textarea textarea--auto"
          value={t.input}
          onChange={(e) => t.setInput(e.target.value)}
          placeholder="Type a word or a sentence…"
          rows={2}
          aria-label="Text to translate"
        />
        <button
          className="btn"
          onClick={t.submit}
          disabled={t.status === "loading" || !t.input.trim()}
        >
          {t.status === "loading" ? "…" : "Translate"}
        </button>
      </div>

      {t.error && <pre className="review__error">{t.error}</pre>}

      {t.status === "done" && t.mode === "word" && (
        <WordResults
          headword={t.headword}
          meanings={t.meanings}
          saved={t.saved}
          saving={t.saving}
          onSave={t.addSense}
        />
      )}

      {t.status === "done" && t.mode === "paragraph" && t.para && (
        <>
          {t.para.translated && <div className="para__translation">{t.para.translation}</div>}
          {t.addableCount > 0 && (
            <button className="btn reader__addall" onClick={t.addAll}>
              + Add all {t.addableCount} new {t.addableCount === 1 ? "word" : "words"}
            </button>
          )}
          <ParagraphReader
            text={t.analyzedInput}
            tokens={t.para.tokens}
            meaningsByWord={t.para.meanings}
            saved={t.saved}
            saving={t.saving}
            confidence={t.confidence}
            onAdd={t.addSense}
            onMarkUnknown={t.markUnknown}
          />
        </>
      )}
    </section>
  );
}

function WordResults({
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
      <div className="result__text">
        <span className="result__head">{word.input}</span>
        {word.inputReading && <span className="result__reading">{word.inputReading}</span>}
        <span className="result__arrow">→</span>
        <span className="result__meaning">{word.translation}</span>
        {word.translationReading && <span className="result__reading">{word.translationReading}</span>}
      </div>
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
