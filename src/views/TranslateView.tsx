// One translate surface. The user types a word OR a sentence into a single box;
// kuromoji (in the hook) decides which, so there's no manual mode toggle:
//   · single word  → all senses, save the primary (others behind a disclosure).
//   · sentence     → the word-by-word reader (hover for meanings + add).
// Orchestration only — input + the language bar, then the mode-specific child
// components. Submit is a BUTTON (never Enter — IME safety).
import { useTranslate } from "../hooks/useTranslate";
import { LangBar } from "../components/translate/LangBar";
import { ParagraphReader } from "../components/translate/ParagraphReader";
import { DestinationPicker } from "../components/translate/DestinationPicker";
import { WordResults } from "../components/translate/WordResults";
import "../components/translate/translate.css";

export function TranslateView({ userId }: { userId: string }) {
  const t = useTranslate(userId);

  const hasResults =
    t.status === "done" && (t.mode === "word" ? t.meanings.length > 0 : t.addableCount > 0);

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

      {/* Destination for every add button below (word adds + "Add all"). */}
      {hasResults && (
        <DestinationPicker
          lists={t.lists}
          destListId={t.destListId}
          onSelect={t.setDestListId}
          onCreate={t.createDestList}
        />
      )}

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
