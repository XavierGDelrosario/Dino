// Google-Translate-style surface:
//   · a language bar (source · ⇄ swap · target) — swap also moves the output
//     into the input and re-translates;
//   · two boxes side by side: input (left, editable) and output (right, the plain
//     translation);
//   · a centered Translate button below;
//   · then the STUDY section: add-to-list / quiz / review controls + the
//     word-by-word reader (hover a word for its meanings).
// Submit is a BUTTON (never Enter — IME safety). A quiz/review session is a FULL
// takeover so nothing can interfere mid-session.
import { useEffect, useState } from "react";
import { useTranslate } from "../hooks/useTranslate";
import { LangBar } from "../components/translate/LangBar";
import { ParagraphReader } from "../components/translate/ParagraphReader";
import { WordResults } from "../components/translate/WordResults";
import { AddToListButton } from "../components/translate/AddToListButton";
import { TextQuizView, type QuizMode } from "./TextQuizView";
import { targetOptions } from "../services/language";
import type { Word } from "../services/words/repository";
import "../components/translate/translate.css";

export function TranslateView({ userId }: { userId: string }) {
  const t = useTranslate(userId);
  const [quiz, setQuiz] = useState<{ words: Word[]; mode: QuizMode } | null>(null);

  // Snapshot a paragraph's NEW words ONCE when its result arrives. The live
  // addablePrimaries empties as words get saved, which would otherwise unmount the
  // "Add all" button mid-interaction (so its ✓→+ →menu flow couldn't play out).
  const [addAllWords, setAddAllWords] = useState<Word[]>([]);
  useEffect(() => {
    if (t.status === "done" && t.mode === "paragraph") setAddAllWords(t.addablePrimaries);
    else if (t.status !== "done") setAddAllWords([]);
    // Snapshot only when a fresh result/paragraph arrives — NOT as words save
    // (addablePrimaries is intentionally excluded so the button stays mounted).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.status, t.mode, t.para]);

  // Quiz/review = full takeover: the entire translate surface is hidden.
  if (quiz) {
    return (
      <section className="translate">
        <TextQuizView
          userId={userId}
          words={quiz.words}
          mode={quiz.mode}
          onGraded={t.applyReview}
          onClose={() => setQuiz(null)}
        />
      </section>
    );
  }

  const wordStudy = t.status === "done" && t.mode === "word" && t.meanings.length > 0;
  const paraStudy = t.status === "done" && t.mode === "paragraph" && t.para;
  const hasActions = addAllWords.length > 0 || t.addableCount > 0 || t.reviewableCount > 0;

  return (
    <section className="translate">
      <LangBar
        source={t.source}
        target={t.target}
        onSource={t.setSource}
        onTarget={t.setTarget}
        onSwap={t.swap}
      />

      {/* Two boxes: input (left) | output (right) */}
      <div className="translate__io">
        <textarea
          className="textarea translate__box"
          value={t.input}
          onChange={(e) => t.setInput(e.target.value)}
          placeholder="Type a word or a sentence…"
          rows={4}
          aria-label="Text to translate"
        />
        <div className="translate__box translate__out" aria-label="Translation">
          {t.status === "loading" ? (
            <span className="translate__placeholder">Translating…</span>
          ) : t.output ? (
            t.output
          ) : (
            <span className="translate__placeholder">Translation</span>
          )}
        </div>
      </div>

      <div className="translate__submit">
        <button
          className="btn"
          onClick={() => t.submit()}
          disabled={t.status === "loading" || !t.input.trim()}
        >
          {t.status === "loading" ? "…" : "Translate"}
        </button>
      </div>

      {/* The language you're learning: the study section below always targets it
          (its words get added/quizzed), whether you typed it or it's the output. */}
      <label className="learnpick">
        I'm learning:
        <select
          className="select select--sm"
          value={t.learning}
          onChange={(e) => t.setLearning(e.target.value)}
          aria-label="Language I'm learning"
        >
          {targetOptions().map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
            </option>
          ))}
        </select>
      </label>

      {t.error && <pre className="review__error">{t.error}</pre>}

      {/* STUDY section: add/quiz/review controls + the hover-for-meaning reader. */}
      {(wordStudy || paraStudy) && (
        <div className="study">
          {wordStudy && (
            <WordResults
              headword={t.headword}
              meanings={t.meanings}
              saved={t.saved}
              confidence={t.confidence}
              lists={t.lists}
              onAdd={t.addWords}
              onCreateList={t.createNamedList}
            />
          )}

          {paraStudy && t.para && (
            <>
              {hasActions && (
                <div className="reader__actions">
                  {addAllWords.length > 0 && (
                    <AddToListButton
                      words={addAllWords}
                      lists={t.lists}
                      label={`+ Add all ${addAllWords.length} new ${addAllWords.length === 1 ? "word" : "words"}`}
                      onAdd={t.addWords}
                      onCreateList={t.createNamedList}
                      className="btn reader__addall"
                    />
                  )}
                  {t.addableCount > 0 && (
                    <button
                      className="btn"
                      onClick={() => setQuiz({ words: t.addablePrimaries, mode: "learn" })}
                    >
                      Quiz {t.addableCount} new {t.addableCount === 1 ? "word" : "words"}
                    </button>
                  )}
                  {t.reviewableCount > 0 && (
                    <button
                      className="btn"
                      onClick={() => setQuiz({ words: t.reviewablePrimaries, mode: "review" })}
                    >
                      Review {t.reviewableCount} saved {t.reviewableCount === 1 ? "word" : "words"}
                    </button>
                  )}
                </div>
              )}
              <ParagraphReader
                text={t.analyzedInput}
                tokens={t.para.tokens}
                meaningsByWord={t.para.meanings}
                saved={t.saved}
                confidence={t.confidence}
                lists={t.lists}
                onAdd={t.addWords}
                onCreateList={t.createNamedList}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}
